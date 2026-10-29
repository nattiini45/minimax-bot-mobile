/**
 * Durable Object adapter over {@link RelaySession}.
 *
 * One Durable Object per account. The Worker routes every request for an account to the
 * same object, so the bridge and its phones always meet in the same room and the socket
 * registry lives in one place.
 */

import { DurableObject } from 'cloudflare:workers';

import { newId, type PeerRole, type TokenPayload } from '@minimax-bot/protocol';

import { accountIdFromPath } from './account-path.js';
import { RelaySession, type DeviceRecord, type PeerSocket, type SessionStatus, type SocketLike } from './session.js';

export interface RelayEnv {
  RELAY_SECRET: string;
}

interface SocketEntry {
  peer: PeerSocket;
}

/**
 * The Durable Object that holds one account's room.
 *
 * It extends the `DurableObject` base class from `cloudflare:workers` on purpose. The
 * Worker reaches the object through `stub.createPairingCode(...)` and friends, which is
 * Workers RPC: the runtime only serves those calls when the class extends the base
 * class. A class written in the older style still type-checks (and the stub still
 * answers `fetch`), but every RPC call fails at runtime with "the receiving Durable
 * Object does not support RPC" — which is exactly what the first live run showed.
 */
export class Relay extends DurableObject<RelayEnv> {
  private readonly session: RelaySession;
  private readonly sockets = new Map<WebSocket, SocketEntry>();

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    this.session = new RelaySession({ secret: env.RELAY_SECRET, storage: ctx.storage });
  }

  // -- RPC surface used by the Worker --------------------------------------

  createPairingCode(bridgeId: string, bridgeName: string): Promise<{ code: string; expiresAt: number }> {
    return this.session.createPairingCode(bridgeId, bridgeName);
  }

  /**
   * Issues a fresh bridge token for this account and kills every older one.
   */
  async rotateBridgeToken(
    bridgeId: string,
    accountId: string,
  ): Promise<{ token: string; expiresAt: number }> {
    return this.session.rotateBridgeToken(bridgeId, accountId);
  }

  /**
   * Kills every bridge token issued at or before `instant`.
   */
  revokeBridgeTokensBefore(instant: number): Promise<void> {
    return this.session.revokeBridgeTokensBefore(instant);
  }

  /**
   * The instant before which every bridge token is dead, or null.
   */
  bridgeTokenCutoff(): Promise<number | null> {
    return this.session.bridgeTokenCutoff();
  }

  /**
   * Whether a bridge token has been revoked.
   */
  isBridgeTokenRevoked(payload: TokenPayload | null): Promise<boolean> {
    return this.session.isBridgeTokenRevoked(payload);
  }

  async pairDevice(
    code: string,
    deviceId: string,
    deviceName: string,
    clientVersion: string,
  ) {
    return this.session.pairDevice(code, deviceId, deviceName, clientVersion);
  }

  revokeDevice(deviceId: string): Promise<boolean> {
    return this.session.revokeDevice(deviceId);
  }

  /**
   * Mints a ticket for a single connection.
   *
   * The ticket stands for the credential the caller presented, for half a minute
   * and for one connection only.
   */
  issueTicket(subject: string, role: PeerRole, credential: string, accountId: string) {
    return this.session.issueTicket(subject, role, credential, accountId);
  }

  /**
   * A device releases its own token.
   *
   * The token has to be the one this account's registry issued to that device.
   */
  releaseDevice(deviceId: string, token: string): Promise<boolean> {
    return this.session.releaseDevice(deviceId, token);
  }

  listDevices(): Promise<DeviceRecord[]> {
    return this.session.listDevices();
  }

  /**
   * Whether a token is one this room issued to that phone.
   *
   * The device registry is the list of live credentials, so it decides.
   */
  authorizesDevice(deviceId: string, token: string): Promise<boolean> {
    return this.session.authorizesDevice(deviceId, token);
  }

  /** The bridge that owns this account, or null if no bridge has claimed it yet. */
  ownerBridgeId(): Promise<string | null> {
    return this.session.resolveOwnerBridgeId();
  }

  status(): Promise<SessionStatus> {
    return this.session.status();
  }

  // -- WebSocket transport -------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/ws')) {
      return new Response('not found', { status: 404 });
    }

    // The room this socket is joining. The Worker routes /r/:accountId/ws to the
    // object for that account, and the path is the only place the account is
    // named — the object itself is addressed by an id, not by a name. It is
    // parsed with the same helper the Worker uses, because the two sides compare
    // the account in the path against the account the token was minted for.
    const accountId = accountIdFromPath(url.pathname);

    const role = url.searchParams.get('role');
    const subject = url.searchParams.get('subject') ?? '';
    // The credential is a ticket when the peer asked for one, and the
    // long-lived token otherwise.
    const token = url.searchParams.get('ticket') ?? url.searchParams.get('token') ?? '';
    const name = url.searchParams.get('name') ?? undefined;
    const lastSeqRaw = url.searchParams.get('lastSeq');
    const lastSeq = lastSeqRaw ? Number.parseInt(lastSeqRaw, 10) : undefined;

    if (role !== 'bridge' && role !== 'device') {
      return new Response('bad role', { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const peer: PeerSocket = {
      id: newId('peer'),
      role,
      subject,
      socket: server as unknown as SocketLike,
      name,
    };

    const registered = await this.session.registerSocket({
      id: peer.id,
      role,
      subject,
      token,
      socket: peer.socket,
      name,
      lastSeq: Number.isFinite(lastSeq) ? lastSeq : undefined,
      accountId,
    });

    if (!registered.ok) {
      // The upgrade is accepted and the socket is closed with the reason. Answering
      // the handshake with an HTTP error instead would reach the peer as a bare
      // "connection failed": a phone that was unpaired on the desktop could not tell
      // that apart from a relay that is merely down, and would retry a credential
      // that can never work.
      server.accept();
      try {
        server.close(registered.code, registered.reason);
      } catch {
        /* the socket may already be gone */
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // The socket is accepted with `server.accept()` rather than
    // `state.acceptWebSocket()`: the hibernation API lets the Durable Object be
    // evicted while the socket is open, and every piece of this relay's state — the
    // sequence counter, the replay ring, the device registry — lives in memory. An
    // eviction would silently reset all of it and drop every frame.
    //
    // Because the socket is *not* a hibernating one, its events are delivered to the
    // listeners registered here. The `webSocketMessage` handler on the class is only
    // ever called for a socket accepted with `state.acceptWebSocket()`; relying on it
    // would mean the relay never sees a single frame the peers send.
    server.accept();
    this.sockets.set(server, { peer });

    server.addEventListener('message', (event) => {
      this.onSocketMessage(server, event.data);
    });
    server.addEventListener('close', () => {
      this.onSocketClose(server);
    });
    server.addEventListener('error', () => {
      this.onSocketClose(server);
    });

    if (role === 'device') {
      // The hello is built without an await, so it cannot disagree with the replay
      // that was computed a moment earlier.
      //
      // The counter below and the replay above have to come from the same instant.
      // An await here would let a frame from the bridge arrive in between: the
      // counter would move on, that frame would reach the phone *before* the hello,
      // and the replayed frames that follow would then be discarded by the phone as
      // frames it had already seen. The phone would have a hole in its view and
      // nothing would tell it so. That is why both are read synchronously here.
      const hello = {
        v: 1,
        id: newId('hello'),
        ts: Date.now(),
        type: 'hello.ok',
        source: 'relay' as const,
        payload: {
          seq: this.session.lastSeq,
          bridgeOnline: this.session.bridgeOnline,
          truncated: registered.replay.truncated,
        },
      };
      this.sendTo(server, JSON.stringify(hello));

      for (const entry of registered.replay.entries) {
        this.sendTo(server, entry.data);
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Handles one frame that arrived on a peer socket. */
  private onSocketMessage(ws: WebSocket, data: unknown): void {
    const entry = this.sockets.get(ws);
    if (!entry) return;
    const raw =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : ArrayBuffer.isView(data)
            ? new TextDecoder().decode(data)
            : '';
    if (!raw) return;
    this.session.handleFrame(entry.peer, raw);
  }

  /** Forgets a peer socket that has closed or failed. */
  private onSocketClose(ws: WebSocket): void {
    const entry = this.sockets.get(ws);
    if (!entry) return;
    this.sockets.delete(ws);
    this.session.unregisterSocket(entry.peer.id);
  }

  private sendTo(ws: WebSocket, data: string): void {
    try {
      ws.send(data);
    } catch {
      /* the socket died between the check and the send */
    }
  }
}
