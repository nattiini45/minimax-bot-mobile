/**
 * Relay client.
 *
 * Holds the WebSocket to the relay, reconnects with an escalating backoff and resumes
 * from the last sequence number it saw. Frames sent while offline are queued so a
 * message composed on the train reaches the team when the signal comes back.
 */

import { createFrame, type Frame } from '@minimax-bot/protocol';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_QUEUE = 100;

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'offline';

export interface RelayClientOptions {
  url: string;
  accountId: string;
  deviceId: string;
  token: string;
  clientVersion: string;
  onFrame?: (frame: Frame) => void;
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
}

export class RelayClient {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = 'idle';
  private attempt = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: string[] = [];
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
    const base = this.options.url.replace(/\/+$/, '');
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
      this.attempt = 0;
      this.setStatus('online');
      this.flush();
    };

    socket.onmessage = (event) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      let frame: Frame;
      try {
        frame = JSON.parse(raw) as Frame;
      } catch {
        return;
      }
      if (typeof frame.seq === 'number' && frame.seq > this.lastSeq) {
        this.lastSeq = frame.seq;
      }
      this.options.onFrame?.(frame);
    };

    socket.onclose = () => {
      this.socket = null;
      this.setStatus('offline');
      if (!this.closed) this.scheduleReconnect();
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

  /** Sends a frame. Frames sent while offline are queued and flushed on reconnect. */
  send(frame: Frame): boolean {
    const raw = JSON.stringify(frame);
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(raw);
      return true;
    }
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
    }
    this.queue.push(raw);
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

  private flush(): void {
    const pending = this.queue;
    this.queue = [];
    for (const raw of pending) {
      try {
        this.socket?.send(raw);
      } catch {
        this.queue.push(raw);
      }
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }
}
