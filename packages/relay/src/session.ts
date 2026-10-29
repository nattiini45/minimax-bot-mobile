/**
 * Framework-agnostic relay session.
 *
 * All relay behaviour lives here so it can be unit tested without a Cloudflare runtime:
 * the Durable Object is a thin adapter over this class. The session owns pairing codes,
 * device credentials, the event ring and the socket registry.
 *
 * What survives a restart and what does not is a decision, not an accident:
 *
 * - The **device registry**, the **pairing codes**, the **account's owner** and the
 *   **sequence counter** are durable. They live in the Durable Object's storage.
 *   Losing them unpairs every phone and rewinds the replay cursor, which is the
 *   surprise this session exists to remove.
 * - The **socket registry** and the **replay ring** are ephemeral. A socket cannot
 *   survive an eviction anyway, and the ring is a cache of the last few hundred
 *   frames — the sequence counter is the source of truth, so a ring that cannot
 *   serve a client is reported to it as a gap instead of being skipped in silence.
 */

import {
  CLOSE_CODE,
  DEVICE_TOKEN_TTL_MS,
  PAIRING_CODE_TTL_MS,
  generatePairingCode,
  issueToken,
  verifyToken,
  type PairingResponse,
  type PeerRole,
  type TokenPayload,
} from '@minimax-bot/protocol';

import { SeqRing, type RingEntry } from './ring.js';

/**
 * How long a ticket for a single connection is good for.
 *
 * It has to be long enough for the handshake and short enough that a URL which
 * was kept somewhere is worthless by the time anybody reads it.
 */
const TICKET_TTL_MS = 30_000;

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface PeerSocket {
  id: string;
  role: PeerRole;
  /** Device id for devices, bridge id for the bridge. */
  subject: string;
  socket: SocketLike;
  name?: string;
}

export interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  clientVersion: string;
  /**
   * The digest of the token the relay issued to this device.
   *
   * The registry only ever asks whether the token it is given is the one it
   * issued, so it keeps a digest rather than the credential: a copy of the
   * Durable Object's storage is then a set of device ids, not a set of live
   * phone credentials.
   */
  tokenHash: string;
  expiresAt: number;
  linkedAt: number;
  revoked: boolean;
}

export interface PairingCodeRecord {
  code: string;
  bridgeId: string;
  bridgeName: string;
  expiresAt: number;
}

export interface SessionOptions {
  secret: string;
  ringCapacity?: number;
  deviceTokenTtlMs?: number;
  now?: () => number;
  /**
   * Durable storage, when the host has one.
   *
   * The durable state of the room lives here: the device registry, the pairing
   * codes, the account's owner and the sequence counter. Without it a restart
   * empties the room.
   */
  storage?: SessionStorage;
}

/**
 * The part of a Durable Object's storage the session needs.
 *
 * It is the shape of `ctx.storage`, kept to two calls so the session stays
 * testable without a Cloudflare runtime.
 */
export interface SessionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** How long a bridge token the relay issues stays valid. */
export const BRIDGE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Where the revocation cutoff is kept. */
const BRIDGE_TOKEN_CUTOFF_KEY = 'bridge-token-cutoff';
/** Where the device registry is kept. */
const DEVICES_KEY = 'devices';
/** Where the outstanding pairing codes are kept. */
const PAIRING_CODES_KEY = 'pairing-codes';
/** Where the bridge that owns the account is kept. */
const OWNER_BRIDGE_KEY = 'owner-bridge';
/** Where the sequence counter is kept. */
const SEQ_KEY = 'seq';

export interface PairingCodeResult {
  code: string;
  expiresAt: number;
}

export interface SessionStatus {
  bridgeOnline: boolean;
  deviceCount: number;
  activeDevices: number;
  lastSeq: number;
}

const DEFAULT_RING_CAPACITY = 512;
/** Wrong pairing codes allowed per window before the endpoint starts refusing. */
const MAX_PAIR_ATTEMPTS = 10;
const PAIR_BLOCK_MS = 60 * 1000;

export class RelaySession {
  private readonly codes = new Map<string, PairingCodeRecord>();
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly deviceSockets = new Map<string, PeerSocket>();
  private bridgeSocket: PeerSocket | null = null;
  /**
   * The bridge that owns this account.
   *
   * Set when the desktop asks for a pairing code. It is what binds a bridge token to
   * an account, so a token minted for one desktop cannot manage another account's
   * devices. It is durable: an account that forgets its owner would let the next
   * desktop to ask for a code take the room over.
   */
  private bridgeId: string | null = null;
  /** Wrong pairing guesses since the last success, and the block they trigger. */
  private failedPairAttempts = 0;
  private pairBlockedUntil = 0;
  /**
   * Bridge tokens issued at or before this instant are dead.
   *
   * A revocation names a moment rather than a token: rotating the bridge token
   * kills every token issued before it, including one that was minted and never
   * used. `null` means nothing has been revoked yet.
   */
  private revokedBridgeTokensBefore: number | null = null;
  private cutoffLoaded = false;
  private readonly ring: SeqRing;
  private seq = 0;

  private readonly secret: string;
  private readonly deviceTokenTtlMs: number;

  /**
   * The tickets that have been used, with the moment they run out.
   *
   * A ticket is good for one connection, so the second attempt with the same
   * one has to be refused.
   */
  private readonly usedTickets = new Map<string, number>();
  private readonly now: () => number;
  private readonly storage: SessionStorage | undefined;

  /** The one read of the durable state, started the first time it is needed. */
  private loading: Promise<void> | null = null;
  /** The queue the sequence counter is written through. */
  private seqWrite: Promise<void> = Promise.resolve();
  /** True when the counter has moved since the last write. */
  private seqDirty = false;

  constructor(options: SessionOptions) {
    this.secret = options.secret;
    this.ring = new SeqRing(options.ringCapacity ?? DEFAULT_RING_CAPACITY);
    this.deviceTokenTtlMs = options.deviceTokenTtlMs ?? DEVICE_TOKEN_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.storage = options.storage;
  }

  // -- durable state --------------------------------------------------------

  /**
   * Reads the durable state, once.
   *
   * Every entry point that touches the registry waits for this. Nothing can run
   * before it has finished: a socket is only accepted after `registerSocket`,
   * which waits for the load, so the sequence counter is never handed out before
   * the stored one has been read.
   */
  private ensureLoaded(): Promise<void> {
    if (!this.loading) {
      this.loading = this.load();
    }
    return this.loading;
  }

  private async load(): Promise<void> {
    const storage = this.storage;
    if (!storage) return;
    const [devices, codes, owner, seq] = await Promise.all([
      storage.get<DeviceRecord[]>(DEVICES_KEY),
      storage.get<PairingCodeRecord[]>(PAIRING_CODES_KEY),
      storage.get<string>(OWNER_BRIDGE_KEY),
      storage.get<number>(SEQ_KEY),
    ]);
    if (Array.isArray(devices)) {
      for (const device of devices) {
        if (device && typeof device.deviceId === 'string') {
          this.devices.set(device.deviceId, device);
        }
      }
    }
    if (Array.isArray(codes)) {
      const now = this.now();
      for (const record of codes) {
        // A code that ran out while the relay was down is not a code any more.
        if (record && typeof record.code === 'string' && record.expiresAt > now) {
          this.codes.set(record.code, record);
        }
      }
    }
    if (typeof owner === 'string' && owner) this.bridgeId = owner;
    if (typeof seq === 'number' && Number.isFinite(seq) && seq > this.seq) this.seq = seq;
  }

  /** Writes the device registry down. */
  private async persistDevices(): Promise<void> {
    await this.storage?.put(DEVICES_KEY, [...this.devices.values()]);
  }

  /** Writes the outstanding pairing codes down, without the ones that ran out. */
  private async persistCodes(): Promise<void> {
    this.pruneExpiredCodes();
    await this.storage?.put(PAIRING_CODES_KEY, [...this.codes.values()]);
  }

  /** Writes the account's owner down. */
  private async persistOwner(): Promise<void> {
    if (this.bridgeId === null) return;
    await this.storage?.put(OWNER_BRIDGE_KEY, this.bridgeId);
  }

  /**
   * Writes the sequence counter down, without waiting for it.
   *
   * The counter moves on every event frame and a Durable Object's storage write is
   * not free, so the writes are queued and coalesced: a frame that arrives while
   * a write is in flight is written by the next one, with the value the counter
   * has at that moment. What lands in storage is always the newest counter and
   * never an older one.
   */
  private persistSeq(): void {
    this.seqDirty = true;
    this.seqWrite = this.seqWrite.then(
      () => this.flushSeq(),
      () => this.flushSeq(),
    );
  }

  private async flushSeq(): Promise<void> {
    if (!this.seqDirty) return;
    this.seqDirty = false;
    const value = this.seq;
    try {
      await this.storage?.put(SEQ_KEY, value);
    } catch {
      /* the next frame tries again */
    }
  }

  /**
   * Waits until the durable state has been written down.
   *
   * The sequence counter is written as the frames arrive rather than one write
   * per frame, so this is how a caller waits for the counter to be on disk.
   */
  async flush(): Promise<void> {
    await this.seqWrite;
  }

  // -- bridge token lifecycle ------------------------------------------------

  /**
   * The instant before which every bridge token is dead, or `null`.
   *
   * @returns {Promise<number | null>}
   */
  async bridgeTokenCutoff(): Promise<number | null> {
    if (!this.cutoffLoaded) {
      this.cutoffLoaded = true;
      const stored = await this.storage?.get<number>(BRIDGE_TOKEN_CUTOFF_KEY);
      if (typeof stored === 'number') {
        this.revokedBridgeTokensBefore = stored;
      }
    }
    return this.revokedBridgeTokensBefore;
  }

  /**
   * Kills every bridge token issued at or before `instant`.
   *
   * @param {number} instant epoch ms
   */
  async revokeBridgeTokensBefore(instant: number): Promise<void> {
    this.cutoffLoaded = true;
    this.revokedBridgeTokensBefore = instant;
    await this.storage?.put(BRIDGE_TOKEN_CUTOFF_KEY, instant);
  }

  /**
   * Whether a bridge token has been revoked.
   *
   * A token that carries no issue time counts as issued at the beginning of
   * time, so it dies with the first revocation.
   *
   * @param {TokenPayload | null} payload
   * @returns {Promise<boolean>}
   */
  async isBridgeTokenRevoked(payload: TokenPayload | null): Promise<boolean> {
    const cutoff = await this.bridgeTokenCutoff();
    if (cutoff === null) return false;
    if (!payload) return true;
    return (payload.iat ?? 0) <= cutoff;
  }

  /**
   * Issues a fresh bridge token and kills every older one.
   *
   * @param {string} bridgeId the bridge the token belongs to
   * @param {string} accountId the account the token is bound to
   */
  async rotateBridgeToken(
    bridgeId: string,
    accountId: string,
  ): Promise<{ token: string; expiresAt: number }> {
    const now = this.now();
    // The new token is issued a millisecond after the cutoff, so the revocation
    // cannot catch the token that caused it. Two tokens minted in the same
    // millisecond would otherwise be indistinguishable by time, and the old one
    // would survive the rotation that was meant to kill it.
    const issuedAt = now + 1;
    const { token, expiresAt } = await issueToken(
      bridgeId,
      'bridge',
      BRIDGE_TOKEN_TTL_MS,
      this.secret,
      { accountId, now: issuedAt },
    );
    // Everything issued at or before `now` is dead, including the token this
    // rotation replaces.
    await this.revokeBridgeTokensBefore(now);
    return { token, expiresAt };
  }

  // -- pairing -------------------------------------------------------------

  /**
   * Issues a short-lived pairing code the phone can type.
   *
   * The code and the account's owner are written down before the code is handed
   * out: a code that a restart would wipe is a code the phone cannot use.
   */
  async createPairingCode(bridgeId: string, bridgeName: string): Promise<PairingCodeResult> {
    await this.ensureLoaded();
    this.pruneExpiredCodes();
    // An account belongs to one bridge. A second bridge must not be able to take it
    // over: it would mint a device token inside someone else's account and read
    // their whole team.
    if (this.bridgeId !== null && this.bridgeId !== bridgeId) {
      throw new Error('ACCOUNT_OWNED');
    }
    const code = generatePairingCode(secureRandom);
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.codes.set(code, { code, bridgeId, bridgeName, expiresAt });
    // The desktop identifies itself here; from now on its token is the one that
    // manages this account's devices.
    this.bridgeId = bridgeId;
    await this.persistOwner();
    await this.persistCodes();
    return { code, expiresAt };
  }

  /** The bridge that owns this account, or null if no bridge has claimed it yet. */
  get ownerBridgeId(): string | null {
    return this.bridgeId;
  }

  /**
   * The bridge that owns this account, once the durable state has been read.
   *
   * The getter is the in-memory answer; this is the one a request may act on,
   * because it waits for the registry to be loaded first.
   */
  async resolveOwnerBridgeId(): Promise<string | null> {
    await this.ensureLoaded();
    return this.bridgeId;
  }

  /** Exchanges a pairing code for a device token. */
  async pairDevice(
    code: string,
    deviceId: string,
    deviceName: string,
    clientVersion: string,
  ): Promise<PairingResponse> {
    await this.ensureLoaded();
    // A wrong guess must not be free: the code space is only a million, and the
    // endpoint is unauthenticated by design (the code is the credential).
    if (this.now() < this.pairBlockedUntil) {
      return {
        ok: false,
        code: 'RATE_LIMITED',
        message: 'Too many wrong codes. Wait a moment and ask the desktop for a new one.',
      };
    }

    // Look the code up before pruning, so an expired code is reported as expired rather
    // than as unknown: the phone needs to know to ask the desktop for a new one.
    const record = this.codes.get(code);
    if (!record) {
      this.pruneExpiredCodes();
      this.failedPairAttempts += 1;
      if (this.failedPairAttempts >= MAX_PAIR_ATTEMPTS) {
        this.failedPairAttempts = 0;
        this.pairBlockedUntil = this.now() + PAIR_BLOCK_MS;
      }
      return { ok: false, code: 'PAIRING_CODE_UNKNOWN', message: 'No bridge is waiting for that code.' };
    }
    if (record.expiresAt <= this.now()) {
      this.codes.delete(code);
      await this.persistCodes();
      return { ok: false, code: 'PAIRING_CODE_EXPIRED', message: 'That pairing code expired.' };
    }

    // Single use: the code is consumed the moment it is claimed.
    this.codes.delete(code);
    this.failedPairAttempts = 0;
    await this.persistCodes();

    const { token, expiresAt } = await issueToken(
      deviceId,
      'device',
      this.deviceTokenTtlMs,
      this.secret,
      { now: this.now() },
    );

    // A revoked device stays revoked. Re-pairing the same id must not silently
    // re-arm a phone the desktop deliberately cut off.
    const existing = this.devices.get(deviceId);
    if (existing?.revoked) {
      return {
        ok: false,
        code: 'DEVICE_REVOKED',
        message: 'This phone was unpaired on the desktop. Pair it again there first.',
      };
    }

    this.devices.set(deviceId, {
      deviceId,
      deviceName,
      clientVersion,
      tokenHash: await hashToken(token),
      expiresAt,
      linkedAt: this.now(),
      revoked: false,
    });
    // The registry is written down before the token is handed out: a phone that
    // holds a token the registry has never heard of is a phone the relay will
    // refuse the next time it connects.
    await this.persistDevices();

    return { ok: true, deviceToken: token, expiresAt };
  }

  /** Revokes a device. Its token stops working immediately. */
  async revokeDevice(deviceId: string): Promise<boolean> {
    await this.ensureLoaded();
    const device = this.devices.get(deviceId);
    if (!device) return false;
    device.revoked = true;
    // The revocation is written down before it is acted on, so a restart cannot
    // hand a phone back that the desktop deliberately cut off.
    await this.persistDevices();
    const socket = this.deviceSockets.get(deviceId);
    if (socket) {
      try {
        socket.socket.close(CLOSE_CODE.deviceRevoked, 'DEVICE_REVOKED');
      } catch {
        /* the socket may already be gone */
      }
      this.deviceSockets.delete(deviceId);
    }
    return true;
  }

  /**
   * A device releases its own token.
   *
   * The token identifies the device, so a device may only revoke itself. The token
   * has to be the one the registry issued to that device: a token from another
   * account must not revoke a device that happens to carry the same id.
   *
   * @param deviceId The device the token names.
   * @param token The token the caller presented.
   */
  async releaseDevice(deviceId: string, token: string): Promise<boolean> {
    await this.ensureLoaded();
    const device = this.devices.get(deviceId);
    if (!device || !(await tokenMatches(device, token))) return false;
    return this.revokeDevice(deviceId);
  }

  /**
   * Mints a ticket for a single connection.
   *
   * The WebSocket upgrade has to carry the peer's credential, and the browser
   * WebSocket API cannot set a header - so the credential travels in the URL,
   * which is the part of a request that proxies and log pipelines keep. A ticket
   * is what travels instead: it stands for the credential, but only for half a
   * minute and only once, so a URL that is kept somewhere is worth nothing a
   * minute later.
   *
   * @param subject The bridge id or the device id the ticket stands for.
   * @param role Which of the two the ticket is for.
   * @param credential The long-lived credential the caller presented.
   * @param accountId The account the room belongs to.
   * @returns The ticket, or null when the credential is not one this room accepts.
   */
  async issueTicket(
    subject: string,
    role: PeerRole,
    credential: string,
    accountId: string,
  ): Promise<{ ticket: string; expiresAt: number } | null> {
    await this.ensureLoaded();
    this.pruneTickets();
    if (role === 'device') {
      const device = this.devices.get(subject);
      if (!device || device.revoked) return null;
      if (!(await tokenMatches(device, credential))) return null;
    } else {
      const payload = await verifyToken(credential, this.secret);
      if (!payload || payload.role !== 'bridge' || payload.acc !== accountId) return null;
      if (await this.isBridgeTokenRevoked(payload)) return null;
      if (this.bridgeId !== null && this.bridgeId !== payload.sub) return null;
    }

    const { token, expiresAt } = await issueToken(subject, role, TICKET_TTL_MS, this.secret, {
      accountId: role === 'bridge' ? accountId : undefined,
      ticket: true,
    });
    return { ticket: token, expiresAt };
  }

  async listDevices(): Promise<DeviceRecord[]> {
    await this.ensureLoaded();
    return [...this.devices.values()].map((device) => ({ ...device }));
  }

  // -- sockets -------------------------------------------------------------

  /**
   * Registers a peer socket.
   *
   * Returns the replay payload for a device that is resuming, or the close code the
   * peer should be closed with when it is not authorized. The socket is *not* closed
   * here: the transport accepts the upgrade first and closes the socket afterwards,
   * so the peer receives the close code instead of a bare HTTP error.
   */
  async registerSocket(params: {
    id: string;
    role: PeerRole;
    subject: string;
    token: string;
    socket: SocketLike;
    name?: string;
    lastSeq?: number;
    /** The account this room is. A bridge token has to be bound to it. */
    accountId?: string;
  }): Promise<
    | { ok: true; replay: { entries: { seq: number; data: string }[]; truncated: boolean } }
    | { ok: false; code: number; reason: string }
  > {
    await this.ensureLoaded();
    const payload = await verifyToken(params.token, this.secret);
    if (!payload || payload.sub !== params.subject || payload.role !== params.role) {
      return { ok: false, code: CLOSE_CODE.unauthorized, reason: 'UNAUTHORIZED' };
    }

    // A ticket is good for one connection. The second attempt with the same one
    // is refused, so a URL that was kept somewhere cannot be used again.
    const isTicket = payload.tick === true;
    if (isTicket && this.usedTickets.has(payload.jti)) {
      return { ok: false, code: CLOSE_CODE.unauthorized, reason: 'UNAUTHORIZED' };
    }

    if (params.role === 'device') {
      const device = this.devices.get(params.subject);
      // A ticket stands for the device it was minted for, so the registry decides
      // whether the device may still come in. A long-lived token has to be the
      // token the registry issued to that device.
      const allowed = isTicket
        ? Boolean(device && !device.revoked)
        : Boolean(device && !device.revoked && (await tokenMatches(device, params.token)));
      if (!allowed) {
        return { ok: false, code: CLOSE_CODE.deviceRevoked, reason: 'DEVICE_REVOKED' };
      }
      if (isTicket) this.usedTickets.set(payload.jti, payload.exp);
      const peer: PeerSocket = {
        id: params.id,
        role: 'device',
        subject: params.subject,
        socket: params.socket,
        name: device?.deviceName,
      };
      const previous = this.deviceSockets.get(params.subject);
      if (previous && previous.id !== peer.id) {
        try {
          previous.socket.close(CLOSE_CODE.replaced, 'REPLACED');
        } catch {
          /* ignore */
        }
      }
      this.deviceSockets.set(params.subject, peer);
      const replay = this.replayFor(params.lastSeq ?? 0);
      return { ok: true, replay };
    }

    // The bridge has to belong to this room.
    //
    // A bridge token carries the account it was minted for. Without this check a
    // token would be a credential for every account on the relay: any tenant
    // could attach to any other tenant's room, displace the real bridge and
    // read the conversation. A device never gets here — it is already scoped by
    // the device registry above.
    if (payload.acc !== params.accountId) {
      return { ok: false, code: CLOSE_CODE.unauthorized, reason: 'UNAUTHORIZED' };
    }
    // A revoked bridge token is dead even though it is signed and unexpired: the
    // whole point of a revocation is to cut a credential that still looks fine.
    if (await this.isBridgeTokenRevoked(payload)) {
      return { ok: false, code: CLOSE_CODE.unauthorized, reason: 'UNAUTHORIZED' };
    }
    // An account has one owner. Once the owner is known, only that owner may
    // attach — this is what stops a foreign bridge from evicting it. An
    // unclaimed room still accepts a correctly bound token, because the desktop
    // connects before it has asked for its first pairing code.
    if (this.bridgeId !== null && this.bridgeId !== payload.sub) {
      return { ok: false, code: CLOSE_CODE.unauthorized, reason: 'UNAUTHORIZED' };
    }

    // Bridge: only one at a time; a new bridge replaces the old one.
    if (this.bridgeSocket && this.bridgeSocket.id !== params.id) {
      try {
        this.bridgeSocket.socket.close(CLOSE_CODE.replaced, 'REPLACED');
      } catch {
        /* ignore */
      }
    }
    this.bridgeSocket = {
      id: params.id,
      role: 'bridge',
      subject: params.subject,
      socket: params.socket,
      name: params.name,
    };
    if (isTicket) this.usedTickets.set(payload.jti, payload.exp);
    return { ok: true, replay: { entries: [], truncated: false } };
  }

  /**
   * The frames a resuming device missed, and whether it has to resynchronise.
   *
   * The ring is a cache of the last few hundred frames and the sequence counter is
   * the source of truth, so the ring on its own cannot say whether a client is up
   * to date: after a restart the ring is empty while the counter says there were
   * frames. A client that is ahead of the counter, or one the ring cannot serve
   * completely, is told so. A client that is silently short of frames keeps a view
   * of the conversation with a hole in it, and never learns of it.
   */
  private replayFor(lastSeq: number): { entries: RingEntry[]; truncated: boolean } {
    const replay = this.ring.since(lastSeq);
    const missed = this.seq - lastSeq;
    const truncated =
      replay.truncated ||
      lastSeq > this.seq ||
      (missed > 0 && replay.entries.length < missed);
    return { entries: replay.entries, truncated };
  }

  /**
   * Forgets the tickets that have run out.
   *
   * They are kept only so a ticket cannot be used twice, and a ticket that has
   * run out cannot be used at all.
   */
  private pruneTickets(): void {
    const now = this.now();
    for (const [jti, expiresAt] of this.usedTickets) {
      if (expiresAt <= now) this.usedTickets.delete(jti);
    }
  }

  unregisterSocket(id: string): void {
    if (this.bridgeSocket && this.bridgeSocket.id === id) {
      this.bridgeSocket = null;
      return;
    }
    for (const [deviceId, peer] of this.deviceSockets) {
      if (peer.id === id) {
        this.deviceSockets.delete(deviceId);
        return;
      }
    }
  }

  /**
   * Handles a frame from a peer.
   *
   * Device frames are forwarded verbatim to the bridge. Bridge frames are stamped with a
   * monotonic `seq`, buffered, and fanned out to every connected device.
   */
  handleFrame(from: PeerSocket, raw: string): void {
    if (from.role === 'device') {
      // A device that was revoked while its socket was open must stop being able to
      // drive the desktop.
      const device = this.devices.get(from.subject);
      if (device?.revoked) return;
      this.sendToBridge(raw);
      return;
    }
    const prepared = this.prepare(raw);
    if (!prepared) return;
    if (!prepared.buffered) {
      // Control frames answer exactly one request. Buffering them would replay the
      // answers to requests a resuming device never made — a stale `ack` looks like a
      // result, and a stale `err` looks like a failure that just happened.
      this.broadcastToDevices(prepared.data);
      return;
    }
    this.ring.push(this.seq, prepared.data);
    // The counter is written down so that a restart does not rewind it: a phone
    // whose cursor is above the relay's counter is a phone that silently drops
    // every frame the relay sends next.
    this.persistSeq();
    this.broadcastToDevices(prepared.data);
  }

  async status(): Promise<SessionStatus> {
    await this.ensureLoaded();
    let activeDevices = 0;
    for (const device of this.devices.values()) {
      if (!device.revoked) activeDevices += 1;
    }
    return {
      bridgeOnline: this.bridgeSocket !== null,
      deviceCount: this.devices.size,
      activeDevices,
      lastSeq: this.seq,
    };
  }

  get lastSeq(): number {
    return this.seq;
  }

  get deviceSocketCount(): number {
    return this.deviceSockets.size;
  }

  // -- internals -----------------------------------------------------------

  /**
   * Prepares a bridge frame for delivery.
   *
   * Event frames are stamped with a monotonic `seq` and buffered, so a device can
   * resume from where it left off. Control frames are conversation-scoped and are
   * never buffered.
   *
   * A frame the relay cannot read is dropped. A frame with no type, or a type that is
   * not a string, would make the client throw when it reads `frame.type`, so passing it
   * on would break the device that received it.
   */
  private prepare(raw: string): { data: string; buffered: boolean } | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const frame = parsed as Record<string, unknown>;
    if (typeof frame.type !== 'string') return null;
    if (!frame.type.startsWith('evt.')) {
      // A control frame is forwarded exactly as it arrived: it is not sequenced, and
      // the relay does not touch a number it does not own.
      return { data: raw, buffered: false };
    }
    this.seq += 1;
    if ('seq' in frame) {
      // The bridge should not set `seq`; if it does, the relay's number wins.
      frame.seq = this.seq;
      return { data: JSON.stringify(frame), buffered: true };
    }
    // The sequence number is injected into the original text rather than
    // re-serialising the parsed object: re-serialising would round 64-bit integers,
    // and the relay's job is to route frames, not to interpret them.
    return {
      data: raw.replace(/^(\s*)\{/, `$1{"seq":${this.seq},`),
      buffered: true,
    };
  }

  private sendToBridge(raw: string): void {
    const bridge = this.bridgeSocket;
    if (!bridge) return;
    try {
      bridge.socket.send(raw);
    } catch {
      /* the socket died between the check and the send */
    }
  }

  private broadcastToDevices(raw: string): void {
    for (const peer of this.deviceSockets.values()) {
      try {
        peer.socket.send(raw);
      } catch {
        /* drop the dead socket on the next close event */
      }
    }
  }

  private pruneExpiredCodes(): void {
    const now = this.now();
    for (const [code, record] of this.codes) {
      if (record.expiresAt <= now) {
        this.codes.delete(code);
      }
    }
  }
}

/**
 * The pairing code is a credential, so it is drawn from the CSPRNG rather than
 * `Math.random`. The generator itself is the shared one, so the code the relay issues
 * is exactly the code the client's validator accepts.
 */
function secureRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0]! / 2 ** 32;
}

/**
 * The digest the registry keeps instead of the token itself.
 *
 * The registry only ever compares a token with the one it issued, so a digest is
 * enough — and it keeps the Durable Object's storage from being a list of live
 * phone credentials.
 */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Whether the token the caller presented is the one the registry issued. */
async function tokenMatches(device: DeviceRecord, token: string): Promise<boolean> {
  return device.tokenHash === (await hashToken(token));
}

export type { TokenPayload };
