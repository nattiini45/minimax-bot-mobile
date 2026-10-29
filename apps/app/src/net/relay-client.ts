/**
 * Relay client.
 *
 * Holds the WebSocket to the relay, reconnects with an escalating backoff and resumes
 * from the last sequence number it saw. Frames sent while offline are handed back to the
 * caller, which keeps them in its outbox — this client does not keep a second queue of
 * its own, because a frame queued in two places is a frame sent twice.
 */

import { CLOSE_CODE, createFrame, type Frame } from '@minimax-bot/protocol';

import { relayHttpUrl, relayWsUrl } from './relay-url';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/** Close codes the relay uses for a socket it will never serve again. */
export const CLOSE_UNAUTHORIZED = CLOSE_CODE.unauthorized;
export const CLOSE_DEVICE_REVOKED = CLOSE_CODE.deviceRevoked;
export const CLOSE_REPLACED = CLOSE_CODE.replaced;

/**
 * Whether a failed handshake was a refusal of the credential.
 *
 * The relay accepts the upgrade and closes the socket with the reason, so this is a
 * safety net for a relay that answers the handshake with an HTTP error instead: React
 * Native does not surface the status code, only the message, so the message is what
 * there is to go on. Without this the phone would retry a credential the relay has
 * already refused, and the user would only ever see "offline".
 */
function looksLikeRefusal(message: string): boolean {
  return /\b401\b|unauthori[sz]ed|forbidden/i.test(message);
}

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
  /** True once a socket has completed its handshake. */
  private opened = false;
  /** True when the last handshake failed because the credential was refused. */
  private refused = false;
  /**
   * Whether a ticket was refused and the token was used instead.
   *
   * A relay whose room predates the ticket does not know what one is, so the
   * connection is tried once more with the token.
   */
  private usedTokenFallback = false;

  constructor(options: RelayClientOptions) {
    this.options = options;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get resumePoint(): number {
    return this.lastSeq;
  }

  endpoint(ticket?: string | null): string {
    const base = relayWsUrl(this.options.url);
    const params = new URLSearchParams({
      role: 'device',
      subject: this.options.deviceId,
      name: 'Phone',
      lastSeq: String(this.lastSeq),
    });
    // A ticket stands in for the token for one connection. Without one the token
    // rides in the URL, which is the part of a request that proxies and log
    // pipelines keep.
    if (ticket) params.set('ticket', ticket);
    else params.set('token', this.options.token);
    return `${base}/r/${encodeURIComponent(this.options.accountId)}/ws?${params.toString()}`;
  }

  /**
   * Asks the relay for a ticket for the next connection.
   *
   * The request carries the token in a header, which is the one place a
   * credential can be kept out of a URL. A relay that does not offer tickets
   * leaves the token where it was.
   */
  private async fetchTicket(): Promise<string | null> {
    const base = relayHttpUrl(this.options.url);
    try {
      const response = await fetch(`${base}/r/${encodeURIComponent(this.options.accountId)}/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.token}` },
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { ticket?: string };
      return typeof body.ticket === 'string' ? body.ticket : null;
    } catch {
      return null;
    }
  }

  connect(): void {
    if (this.closed) return;
    this.setStatus('connecting');
    this.opened = false;
    this.refused = false;
    // The socket is opened with a ticket when the relay offers one, so the
    // long-lived token does not travel in the URL.
    void this.open();
  }

  private async open(): Promise<void> {
    const ticket = await this.fetchTicket();
    if (this.closed) return;
    this.openSocket(ticket);
  }

  /**
   * Opens the socket, with a ticket for the connection when there is one.
   *
   * @param ticket The ticket, or null to use the token.
   */
  private openSocket(ticket: string | null): void {
    const socket = new WebSocket(this.endpoint(ticket));
    this.socket = socket;

    socket.onopen = () => {
      // The backoff is only reset once the handshake completes. A relay that accepts the
      // socket and then drops it would otherwise be retried every second, forever.
      this.opened = true;
      this.refused = false;
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
      // A connection that was refused before it opened, and that carried a
      // ticket, is tried once more with the token: a relay whose room predates
      // the ticket does not know what one is.
      if (!this.opened && ticket && !this.usedTokenFallback) {
        this.usedTokenFallback = true;
        this.openSocket(null);
        return;
      }
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
      // The handshake never completed and the relay refused the credential outright.
      if (!this.opened && this.refused) {
        this.closed = true;
        this.options.onFatal?.(CLOSE_UNAUTHORIZED);
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = (event) => {
      // `onclose` always follows, so the reconnect is scheduled there. The message is
      // kept because a refused handshake only says so here.
      const message = (event as { message?: string })?.message ?? '';
      if (message) this.refused = looksLikeRefusal(message);
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
