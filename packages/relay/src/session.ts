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
  decodeFrame,
  generatePairingCode,
  isValidPairingCode,
  issueToken,
  verifyToken,
  type Frame,
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
 * It is the shape of `ctx.storage`, kept small so the session stays testable
 * without a Cloudflare runtime.
 */
export interface SessionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  /**
   * Writes several keys in one transaction.
   *
   * The Durable Object's storage applies a multi-key write atomically, which is
   * what lets the room's state be written as one thing: a phone is registered by
   * consuming a pairing code, and a room where the code was consumed but the
   * device was not registered has lost a pairing for nothing.
   */
  put(entries: Record<string, unknown>): Promise<void>;
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

/**
 * Wrong pairing codes allowed per window before the account starts refusing.
 *
 * The budget is spent by codes that were *distinct*: a code that is guessed again and
 * again is charged to its own budget below, so hammering one code cannot use up the
 * account's. The window is short, because the budget is shared between the owner's
 * phone and whoever is guessing: a long block is a block on the real user.
 *
 * Three codes every eighteen seconds is the same sustained rate the account allowed
 * before - ten guesses a minute, in a burst of three rather than a burst of ten - and
 * the lockout it can land in is a third as long.
 */
const MAX_PAIR_ATTEMPTS = 3;
const PAIR_BLOCK_MS = 18 * 1000;

/**
 * Wrong guesses allowed against one code before that code is refused.
 *
 * A code is a six digit guess and the relay's answer to a wrong one is the same for
 * every code, so the only way to make guessing expensive is to make it expensive per
 * code. A code that has been guessed wrongly is worth nothing to the person who
 * guessed it, so it is refused for the rest of the window: the guesses after the first
 * cost the account nothing, and the account's own budget is only spent by codes that
 * are being tried for the first time.
 */
const MAX_CODE_PAIR_ATTEMPTS = 1;
const CODE_BLOCK_MS = 10 * 60 * 1000;

/** How many codes the per-code budgets are kept for at once. */
const MAX_CODE_ATTEMPT_ENTRIES = 512;

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
   * Wrong guesses charged to one code.
   *
   * A code that is guessed again and again is charged here and not to the account's
   * budget, so a flood against a single code cannot lock the owner's phone out of
   * its own pairing.
   */
  private readonly codeAttempts = new Map<string, { count: number; blockedUntil: number; expiresAt: number }>();
  /**
   * Bridge tokens issued at or before this instant are dead.
   *
   * A revocation names a moment rather than a token: rotating the bridge token
   * kills every token issued before it, including one that was minted and never
   * used. `null` means nothing has been revoked yet.
   */
  private revokedBridgeTokensBefore: number | null = null;
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
      this.loading = this.load().catch((error: unknown) => {
        // A failed read must not leave the room unusable for good: the next
        // caller tries again. The failure is passed on, so a request that needs
        // the durable state gets an error rather than an empty room.
        this.loading = null;
        throw error;
      });
    }
    return this.loading;
  }

  private async load(): Promise<void> {
    const storage = this.storage;
    if (!storage) return;
    const [devices, codes, owner, seq, cutoff] = await Promise.all([
      storage.get<DeviceRecord[]>(DEVICES_KEY),
      storage.get<PairingCodeRecord[]>(PAIRING_CODES_KEY),
      storage.get<string>(OWNER_BRIDGE_KEY),
      storage.get<number>(SEQ_KEY),
      storage.get<number>(BRIDGE_TOKEN_CUTOFF_KEY),
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
    // The cutoff is only applied when nothing in memory has revoked a token yet.
    // A revocation that happened while this read was in flight is newer than
    // whatever was on disk when the read started, and it must not be undone by it.
    if (this.revokedBridgeTokensBefore === null && typeof cutoff === 'number') {
      this.revokedBridgeTokensBefore = cutoff;
    }
  }

  /** Writes the device registry down. */
  private async persistDevices(): Promise<void> {
    await this.storage?.put(DEVICES_KEY, [...this.devices.values()]);
  }

  /**
   * Writes the room's durable state down, in one transaction.
   *
   * The registry, the codes and the owner are written together, because they
   * change together: a phone is registered by consuming a code, and the owner
   * is claimed when a code is issued. A room where the code was consumed but the
   * device was not registered has lost a pairing for nothing, and a room that
   * believes it has an owner while nothing on disk says so can be claimed by
   * another desktop after a restart.
   */
  private async persistRoom(): Promise<void> {
    const entries: Record<string, unknown> = {
      [DEVICES_KEY]: [...this.devices.values()],
      [PAIRING_CODES_KEY]: [...this.codes.values()],
    };
    if (this.bridgeId !== null) entries[OWNER_BRIDGE_KEY] = this.bridgeId;
    await this.storage?.put(entries);
  }

  /** Writes the outstanding pairing codes down, without the ones that ran out. */
  private async persistCodes(): Promise<void> {
    this.pruneExpiredCodes();
    await this.storage?.put(PAIRING_CODES_KEY, [...this.codes.values()]);
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
      () => this.writeSeq(),
      () => this.writeSeq(),
    );
  }

  /** Writes the counter down, if it has moved since the last write. */
  private async writeSeq(): Promise<void> {
    if (!this.seqDirty) return;
    this.seqDirty = false;
    const value = this.seq;
    try {
      await this.storage?.put(SEQ_KEY, value);
    } catch {
      // The write failed, so the counter on disk is older than the one in
      // memory. The next frame, or the next flush, tries again. Until it lands, a
      // phone whose cursor is above the stored counter is told to resynchronise
      // rather than being left with a silent hole.
      this.seqDirty = true;
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
    // A frame that arrived while the write was in flight, or a write that
    // failed, is picked up here.
    if (this.seqDirty) await this.writeSeq();
  }

  // -- bridge token lifecycle ------------------------------------------------

  /**
   * The instant before which every bridge token is dead, or `null`.
   *
   * The cutoff is part of the durable state of the room, so it is read with the
   * rest of it. It used to have a load of its own, guarded by a flag that was
   * set before the read had finished - which meant a second caller could arrive
   * while the first was still reading, see the flag, and be told no token had
   * been revoked. One load, one answer.
   *
   * @returns {Promise<number | null>}
   */
  async bridgeTokenCutoff(): Promise<number | null> {
    await this.ensureLoaded();
    return this.revokedBridgeTokensBefore;
  }

  /**
   * Kills every bridge token issued at or before `instant`.
   *
   * The kill switch does not wait for the durable state to be read. A storage
   * that cannot be read is exactly when the kill switch is wanted, and the room
   * acts on the revocation in memory from here on.
   *
   * @param {number} instant epoch ms
   */
  async revokeBridgeTokensBefore(instant: number): Promise<void> {
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
    const record: PairingCodeRecord = { code, bridgeId, bridgeName, expiresAt };
    const previousOwner = this.bridgeId;
    // A code the bridge issues is not a code that was guessed, so any refusal left
    // over for it by an earlier guess is dropped.
    this.codeAttempts.delete(code);

    // The desktop identifies itself here; from now on its token is the one that
    // manages this account's devices. The claim and the code are written down
    // together, and the room only remembers them once the write has landed: a
    // room that believes it has an owner while nothing on disk says so can be
    // claimed by another desktop after a restart.
    this.codes.set(code, record);
    this.bridgeId = bridgeId;
    try {
      await this.persistRoom();
    } catch (error) {
      this.codes.delete(code);
      this.bridgeId = previousOwner;
      throw error;
    }
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

  /**
   * Charges a wrong guess to one code.
   *
   * A code that is guessed again and again is charged here and not to the account's
   * budget, so a flood against one code cannot lock the owner's phone out of its own
   * pairing. The code itself is refused for a long time once it has been guessed, so
   * a sweep that keeps coming back to one code pays for every guess.
   *
   * @returns `blocked` when the code is refused, and `charged` when the guess is a
   *   new one that the account's own budget has to pay for.
   */
  private chargeCodeAttempt(code: string): 'blocked' | 'charged' {
    const now = this.now();
    // Only a code that could be a pairing code is remembered. The key is a string the
    // caller chose, and a caller that sends a sixteen kilobyte "code" would otherwise
    // fill the map with sixteen kilobyte keys. A code that could never be right is
    // charged to the account's budget and forgotten.
    if (!isValidPairingCode(code)) return 'charged';
    const entry = this.codeAttempts.get(code);
    if (entry && entry.blockedUntil > now) return 'blocked';
    // The first guess at a code is charged to the account, and the code is then
    // refused for the rest of the window: the guesses after it cost the attacker
    // requests and the account nothing.
    const used = entry && entry.expiresAt > now ? entry.count : 0;
    const count = used + 1;
    this.codeAttempts.set(code, {
      count,
      blockedUntil: count >= MAX_CODE_PAIR_ATTEMPTS ? now + CODE_BLOCK_MS : 0,
      expiresAt: now + CODE_BLOCK_MS,
    });
    this.pruneCodeAttempts();
    return 'charged';
  }

  /**
   * Keeps the per-code budgets from growing without bound.
   *
   * The key is a string a caller chose, so the map is bounded in age and in size.
   */
  private pruneCodeAttempts(): void {
    const now = this.now();
    for (const [code, entry] of this.codeAttempts) {
      if (entry.expiresAt <= now) this.codeAttempts.delete(code);
    }
    while (this.codeAttempts.size > MAX_CODE_ATTEMPT_ENTRIES) {
      const oldest = this.codeAttempts.keys().next();
      if (oldest.done) break;
      this.codeAttempts.delete(oldest.value);
    }
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
    //
    // The block is the relay's only brake on a sweep through the code space, so it
    // comes first. The window is short, because this budget is shared with the
    // owner's phone: a long block is a block on the real user.
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
      // A code that has already been guessed is charged to its own budget, so that a
      // flood against one code cannot use up the account's budget and lock the owner's
      // phone out of its own pairing.
      const charge = this.chargeCodeAttempt(code);
      if (charge === 'blocked') {
        return {
          ok: false,
          code: 'RATE_LIMITED',
          message: 'Too many wrong codes. Wait a moment and ask the desktop for a new one.',
        };
      }
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
    this.codeAttempts.delete(code);

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
      // The code is spent: it named a device the desktop cut off.
      await this.persistRoom();
      return {
        ok: false,
        code: 'DEVICE_REVOKED',
        message: 'This phone was unpaired on the desktop. Pair it again there first.',
      };
    }

    const device: DeviceRecord = {
      deviceId,
      deviceName,
      clientVersion,
      tokenHash: await hashToken(token),
      expiresAt,
      linkedAt: this.now(),
      revoked: false,
    };
    this.devices.set(deviceId, device);
    try {
      // The registry and the consumed code are written down together, and the
      // token is only handed out once they are: a phone that holds a token the
      // registry has never heard of is a phone the relay will refuse the next
      // time it connects, and a code that was burned for a pairing that never
      // landed is a code the phone has to ask the desktop for again.
      await this.persistRoom();
    } catch (error) {
      // The write failed, so the room goes back to what it was.
      this.codes.set(code, record);
      if (existing) this.devices.set(deviceId, existing);
      else this.devices.delete(deviceId);
      throw error;
    }

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

  /**
   * Whether a token is one this room issued to that phone.
   *
   * The registry is the list of live credentials, so it decides: a token that
   * is not the one it issued to that phone is not the phone's token.
   */
  async authorizesDevice(deviceId: string, token: string): Promise<boolean> {
    await this.ensureLoaded();
    const device = this.devices.get(deviceId);
    if (!device || device.revoked) return false;
    return tokenMatches(device, token);
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
    // Every frame a peer sends is checked against the shared contract before the
    // relay acts on it. The relay does not interpret payloads, but it does rely
    // on the envelope: it routes by type, it owns the order, and the bridge
    // identifies an operation by its id. A frame that does not satisfy the
    // contract is not a frame, and it is dropped rather than passed on.
    let frame: Frame;
    try {
      frame = decodeFrame(raw);
    } catch {
      return;
    }
    // The sequence belongs to the relay. A peer that sets one is saying where
    // its frame belongs in the order, and that is not the peer's to say: the
    // phone takes the relay's number as the order, so a peer-set number would
    // move the phone's cursor past every frame that follows.
    if (frame.seq !== undefined) return;
    // The sender is the relay's to say as well. A frame that names one is not a
    // frame this room accepts: otherwise a phone could send a decision that
    // claims to be another phone's.
    if ('from' in frame) return;

    if (from.role === 'device') {
      // A device that was revoked while its socket was open must stop being able to
      // drive the desktop.
      const device = this.devices.get(from.subject);
      if (device?.revoked) return;
      // The desktop has to know which phone sent the frame. A permission
      // decision is only worth recording if the record says who made it.
      this.sendToBridge(withSender(raw, from.subject));
      return;
    }
    const prepared = this.prepare(raw, frame);
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
      bridgeOnline: this.bridgeOnline,
      deviceCount: this.devices.size,
      activeDevices,
      lastSeq: this.seq,
    };
  }

  get lastSeq(): number {
    return this.seq;
  }

  /**
   * Whether the desktop is attached to this room.
   *
   * It is in-memory state, so it can be read without waiting for anything - which
   * matters because the hello the phone receives on connecting is built from it,
   * and an await in the middle of that would let a frame overtake the hello.
   */
  get bridgeOnline(): boolean {
    return this.bridgeSocket !== null;
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
   * The frame has already been checked against the shared contract by the
   * caller, so the envelope can be relied on here.
   */
  private prepare(raw: string, frame: Frame): { data: string; buffered: boolean } {
    if (!frame.type.startsWith('evt.')) {
      // A control frame is forwarded exactly as it arrived: it is not sequenced, and
      // the relay does not touch a number it does not own.
      return { data: raw, buffered: false };
    }
    this.seq += 1;
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

/**
 * Names the sender on a frame on its way to the desktop.
 *
 * The text is edited rather than re-serialised: re-serialising would round
 * 64-bit integers, and the relay's job is to route frames, not to interpret
 * them. The id is escaped, because a phone chooses its own id and it may
 * contain anything.
 */
function withSender(raw: string, deviceId: string): string {
  return raw.replace(/^(\s*)\{/, `$1{"from":${JSON.stringify(deviceId)},`);
}

/** Whether the token the caller presented is the one the registry issued. */
async function tokenMatches(device: DeviceRecord, token: string): Promise<boolean> {
  return device.tokenHash === (await hashToken(token));
}

export type { TokenPayload };
