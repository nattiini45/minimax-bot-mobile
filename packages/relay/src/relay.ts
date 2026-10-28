/**
 * Durable Object adapter over {@link RelaySession}.
 *
 * One Durable Object per account. The Worker routes every request for an account to the
 * same object, so the bridge and its phones always meet in the same room and the socket
 * registry lives in one place.
 */

import { newId } from '@minimax-bot/protocol';

import { RelaySession, type PeerSocket, type SocketLike } from './session.js';

export interface RelayEnv {
  RELAY_SECRET: string;
}

interface SocketEntry {
  peer: PeerSocket;
}

export class Relay {
  /**
   * Brands the class for the Workers RPC type system.
   *
   * Without it `DurableObjectStub<Relay>` resolves to `Fetcher<undefined>` and the
   * Worker's RPC calls (`stub.pairDevice`, `stub.status`, …) are invisible to `tsc`.
   */
  declare readonly __DURABLE_OBJECT_BRAND: never;

  private readonly session: RelaySession;
  private readonly sockets = new Map<WebSocket, SocketEntry>();

  constructor(
    private readonly state: DurableObjectState,
    env: RelayEnv,
  ) {
    this.session = new RelaySession({ secret: env.RELAY_SECRET });
  }

  // -- RPC surface used by the Worker --------------------------------------

  createPairingCode(bridgeId: string, bridgeName: string): { code: string; expiresAt: number } {
    return this.session.createPairingCode(bridgeId, bridgeName);
  }

  async pairDevice(
    code: string,
    deviceId: string,
    deviceName: string,
    clientVersion: string,
  ) {
    return this.session.pairDevice(code, deviceId, deviceName, clientVersion);
  }

  revokeDevice(deviceId: string): boolean {
    return this.session.revokeDevice(deviceId);
  }

  listDevices() {
    return this.session.listDevices();
  }

  status() {
    return this.session.status();
  }

  // -- WebSocket transport -------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/ws')) {
      return new Response('not found', { status: 404 });
    }

    const role = url.searchParams.get('role');
    const subject = url.searchParams.get('subject') ?? '';
    const token = url.searchParams.get('token') ?? '';
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
    });

    if (!registered) {
      // The session already closed the socket with the right close code.
      return new Response('unauthorized', { status: 401 });
    }

    this.state.acceptWebSocket(server);
    this.sockets.set(server, { peer });

    if (role === 'device') {
      const hello = {
        v: 1,
        id: newId('hello'),
        ts: Date.now(),
        type: 'hello.ok',
        source: 'relay' as const,
        payload: {
          seq: this.session.lastSeq,
          bridgeOnline: this.session.status().bridgeOnline,
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

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const entry = this.sockets.get(ws);
    if (!entry) return;
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    this.session.handleFrame(entry.peer, raw);
  }

  webSocketClose(ws: WebSocket): void {
    const entry = this.sockets.get(ws);
    if (!entry) return;
    this.sockets.delete(ws);
    this.session.unregisterSocket(entry.peer.id);
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  private sendTo(ws: WebSocket, data: string): void {
    try {
      ws.send(data);
    } catch {
      /* the socket died between the check and the send */
    }
  }
}
