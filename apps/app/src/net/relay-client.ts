/**
 * Relay client.
 *
 * Holds the WebSocket to the relay, reconnects with an escalating backoff and resumes
 * from the last sequence number it saw. Frames sent while offline are handed back to the
 * caller, which keeps them in its outbox — this client does not keep a second queue of
 * its own, because a frame queued in two places is a frame sent twice.
 */

import { createFrame, type Frame } from '@minimax-bot/protocol';

import { relayWsUrl } from './relay-url';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/** Close codes the relay uses for a socket it will never serve again. */
export const CLOSE_UNAUTHORIZED = 4001;
export const CLOSE_DEVICE_REVOKED = 4003;
export const CLOSE_REPLACED = 4000;

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'offline';

export interface RelayClientOptions {
  url: string;
  accountId: string;
  deviceId: string;
  token: string;
  clientVersion: string;
  onFrame?: (frame: Frame) => void;
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  /** Called when the relay closed the socket for good; the app must stop retrying. */
  onFatal?: (code: number) => void;
}

export class RelayClient {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = 'idle';
  private attempt = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSeq = 0;
  private options: RelayClientOptions;

  constructor(options: RelayClientOptions) {
    this.options = options;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get resumePoint(): number {
    return this.lastSeq;
  }

  endpoint(): string {
    const base = relayWsUrl(this.options.url);
    const params = new URLSearchParams({
      role: 'device',
      subject: this.options.deviceId,
      token: this.options.token,
      name: 'Phone',
      lastSeq: String(this.lastSeq),
    });
    return `${base}/r/${encodeURIComponent(this.options.accountId)}/ws?${params.toString()}`;
  }

  connect(): void {
    if (this.closed) return;
    this.setStatus('connecting');

    const socket = new WebSocket(this.endpoint());
    this.socket = socket;

    socket.onopen = () => {
      // The backoff is only reset once the handshake completes. A relay that accepts the
      // socket and then drops it would otherwise be retried every second, forever.
      this.setStatus('online');
    };

    socket.onmessage = (event) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      let frame: Frame;
      try {
        frame = JSON.parse(raw) as Frame;
      } catch {
        return;
      }
      if (frame.type === 'hello.ok') {
        this.attempt = 0;
      }
      // A frame the relay has already sequenced is one the app has already applied.
      if (typeof frame.seq === 'number') {
        if (frame.seq <= this.lastSeq) return;
        this.lastSeq = frame.seq;
      }
      this.options.onFrame?.(frame);
    };

    socket.onclose = (event) => {
      this.socket = null;
      this.setStatus('offline');
      if (this.closed) return;
      // A revoked or replaced device must stop trying: reconnecting forever with a
      // credential the relay has already rejected is a loop the user cannot see.
      if (event.code === CLOSE_UNAUTHORIZED || event.code === CLOSE_DEVICE_REVOKED) {
        this.closed = true;
        this.options.onFatal?.(event.code);
        return;
      }
      if (event.code === CLOSE_REPLACED) {
        this.closed = true;
        this.options.onFatal?.(event.code);
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // `onclose` always follows, so the reconnect is scheduled there.
    };
  }

  disconnect(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setStatus('idle');
  }

  /**
   * Sends a frame.
   *
   * Returns false when the socket is not open: the caller keeps the frame in its outbox
   * and sends it again once the connection is back. The same `opId` is reused, so the
   * bridge's deduplication turns a retry into a no-op rather than a second message.
   */
  send(frame: Frame): boolean {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }

  /** Sends an operation with an idempotency key. */
  request(type: string, payload: unknown, opId?: string): boolean {
    return this.send(
      createFrame({
        type,
        payload,
        source: 'app',
        opId: opId ?? `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      }),
    );
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    const delay = base + Math.floor(Math.random() * 400);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }
}
