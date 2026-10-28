/**
 * Framework-agnostic relay session.
 *
 * All relay behaviour lives here so it can be unit tested without a Cloudflare runtime:
 * the Durable Object is a thin adapter over this class. The session owns pairing codes,
 * device credentials, the event ring and the socket registry.
 */

import {
  PAIRING_CODE_TTL_MS,
  type PairingResponse,
  type PeerRole,
} from '@minimax-bot/protocol';

import { issueToken, verifyToken, type TokenPayload } from './auth.js';
import { SeqRing } from './ring.js';

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
  token: string;
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
}

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
const DEFAULT_DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class RelaySession {
  private readonly codes = new Map<string, PairingCodeRecord>();
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly deviceSockets = new Map<string, PeerSocket>();
  private bridgeSocket: PeerSocket | null = null;
  private readonly ring: SeqRing;
  private seq = 0;

  private readonly secret: string;
  private readonly deviceTokenTtlMs: number;
  private readonly now: () => number;

  constructor(options: SessionOptions) {
    this.secret = options.secret;
    this.ring = new SeqRing(options.ringCapacity ?? DEFAULT_RING_CAPACITY);
    this.deviceTokenTtlMs = options.deviceTokenTtlMs ?? DEFAULT_DEVICE_TOKEN_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  // -- pairing -------------------------------------------------------------

  /** Issues a short-lived pairing code the phone can type. */
  createPairingCode(bridgeId: string, bridgeName: string): PairingCodeResult {
    this.pruneExpiredCodes();
    const code = generateCode();
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.codes.set(code, { code, bridgeId, bridgeName, expiresAt });
    return { code, expiresAt };
  }

  /** Exchanges a pairing code for a device token. */
  async pairDevice(
    code: string,
    deviceId: string,
    deviceName: string,
    clientVersion: string,
  ): Promise<PairingResponse> {
    // Look the code up before pruning, so an expired code is reported as expired rather
    // than as unknown: the phone needs to know to ask the desktop for a new one.
    const record = this.codes.get(code);
    if (!record) {
      this.pruneExpiredCodes();
      return { ok: false, code: 'PAIRING_CODE_UNKNOWN', message: 'No bridge is waiting for that code.' };
    }
    if (record.expiresAt <= this.now()) {
      this.codes.delete(code);
      return { ok: false, code: 'PAIRING_CODE_EXPIRED', message: 'That pairing code expired.' };
    }

    // Single use: the code is consumed the moment it is claimed.
    this.codes.delete(code);

    const { token, expiresAt } = await issueToken(
      deviceId,
      'device',
      this.deviceTokenTtlMs,
      this.secret,
      this.now(),
    );

    this.devices.set(deviceId, {
      deviceId,
      deviceName,
      clientVersion,
      token,
      expiresAt,
      linkedAt: this.now(),
      revoked: false,
    });

    return { ok: true, deviceToken: token, expiresAt };
  }

  /** Revokes a device. Its token stops working immediately. */
  revokeDevice(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    device.revoked = true;
    const socket = this.deviceSockets.get(deviceId);
    if (socket) {
      try {
        socket.socket.close(4003, 'DEVICE_REVOKED');
      } catch {
        /* the socket may already be gone */
      }
      this.deviceSockets.delete(deviceId);
    }
    return true;
  }

  listDevices(): DeviceRecord[] {
    return [...this.devices.values()].map((device) => ({ ...device }));
  }

  // -- sockets -------------------------------------------------------------

  /**
   * Registers a peer socket.
   *
   * Returns the replay payload for a device that is resuming, or `null` when the peer is
   * not authorized. Unauthorized sockets are closed rather than left hanging.
   */
  async registerSocket(params: {
    id: string;
    role: PeerRole;
    subject: string;
    token: string;
    socket: SocketLike;
    name?: string;
    lastSeq?: number;
  }): Promise<{ replay: { entries: { seq: number; data: string }[]; truncated: boolean } } | null> {
    const payload = await verifyToken(params.token, this.secret);
    if (!payload || payload.sub !== params.subject || payload.role !== params.role) {
      try {
        params.socket.close(4001, 'UNAUTHORIZED');
      } catch {
        /* ignore */
      }
      return null;
    }

    if (params.role === 'device') {
      const device = this.devices.get(params.subject);
      if (!device || device.revoked || device.token !== params.token) {
        try {
          params.socket.close(4003, 'DEVICE_REVOKED');
        } catch {
          /* ignore */
        }
        return null;
      }
      const peer: PeerSocket = {
        id: params.id,
        role: 'device',
        subject: params.subject,
        socket: params.socket,
        name: device.deviceName,
      };
      const previous = this.deviceSockets.get(params.subject);
      if (previous && previous.id !== peer.id) {
        try {
          previous.socket.close(4000, 'REPLACED');
        } catch {
          /* ignore */
        }
      }
      this.deviceSockets.set(params.subject, peer);
      const replay = this.ring.since(params.lastSeq ?? 0);
      return { replay };
    }

    // Bridge: only one at a time; a new bridge replaces the old one.
    if (this.bridgeSocket && this.bridgeSocket.id !== params.id) {
      try {
        this.bridgeSocket.socket.close(4000, 'REPLACED');
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
    return { replay: { entries: [], truncated: false } };
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
      this.sendToBridge(raw);
      return;
    }
    const stamped = this.stampSeq(raw);
    if (!stamped) return;
    this.ring.push(this.seq, stamped);
    this.broadcastToDevices(stamped);
  }

  status(): SessionStatus {
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
   * Stamps a monotonic `seq` onto an event frame.
   *
   * Only `evt.*` frames are sequenced and buffered: control frames (`ack`, `err`, `hello`)
   * are conversation-scoped and are never replayed.
   */
  private stampSeq(raw: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const frame = parsed as Record<string, unknown>;
    if (typeof frame.type !== 'string' || !frame.type.startsWith('evt.')) {
      // Non-event frames from the bridge are forwarded as-is without a sequence number.
      return raw;
    }
    this.seq += 1;
    frame.seq = this.seq;
    return JSON.stringify(frame);
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

function generateCode(): string {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += String(Math.floor(Math.random() * 10));
  }
  return code;
}

export type { TokenPayload };
