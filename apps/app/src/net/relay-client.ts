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

/**
 * How long a replay may wait for its last frame before it is applied anyway.
 *
 * The relay says how far its counter has reached, so a replay that is complete is
 * recognised by its last frame. A replay the relay could not complete — its buffer
 * no longer holds everything this phone missed — has no such last frame, and this is
 * what lets the phone go on rather than wait for a frame that is never coming.
 */
const HOLD_FLUSH_MS = 250;

/** Close codes the relay uses for a socket it will never serve again. */
export const CLOSE_UNAUTHORIZED = CLOSE_CODE.unauthorized;
export const CLOSE_DEVICE_REVOKED = CLOSE_CODE.deviceRevoked;
export const CLOSE_REPLACED = CLOSE_CODE.replaced;

/**
 * What the ticket request answered.
 *
 * Three things are possible: there is a ticket, the relay refused the credential, or
 * there is no ticket to be had. The refusal is the relay's own status and the relay's
 * own code, so the phone never has to guess it out of a message.
 */
type TicketOutcome =
  | { kind: 'ticket'; ticket: string }
  | { kind: 'refused'; code: string }
  | { kind: 'none' };

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
  /** Whether the relay said it could not replay everything this phone missed. */
  private replayWasIncomplete = false;
  /**
   * The frames the relay replayed, held until the whole replay has arrived.
   *
   * A replay is history. Applied one frame at a time, the phone shows the states the
   * room passed through on the way — including a team that had not been built yet and
   * a desktop that was not running yet — and the user is told the team is not linked
   * while the team is right there. Held and applied together, the phone is given the
   * state the room is in now.
   *
   * @type {Frame[]}
   */
  private held: Frame[] = [];
  /** The number the relay's hello said its counter had reached. */
  private replayTarget = 0;
  /** Whether a replay is being held. */
  private holding = false;
  /** The timer that applies a replay the relay could not finish. */
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The highest number that has arrived, which can be ahead of what the app has.
   *
   * The cursor moves only when the frames have been applied, so the two are separate:
   * a socket that drops mid-replay must not leave the phone claiming to have seen
   * frames the app never received.
   */
  private receivedSeq = 0;
  /** Whether the relay's hello has been seen, so the two counters can be compared. */
  private resumeSettled = false;
  /** Whether the desktop was attached to the room, as the last hello said. */
  private bridgeOnline = false;
  /** How many times this phone has had to rebuild its view. */
  private resyncCounter = 0;
  private options: RelayClientOptions;
  /** True once a socket has completed its handshake. */
  private opened = false;
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
   *
   * A relay that refuses the credential says so with a status and a code of its own,
   * which is what the phone goes on. A relay that is merely unreachable, or that does
   * not know the route, is not a refusal: that is a connection to try again.
   */
  private async fetchTicket(): Promise<TicketOutcome> {
    const base = relayHttpUrl(this.options.url);
    try {
      const response = await fetch(`${base}/r/${encodeURIComponent(this.options.accountId)}/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.token}` },
      });
      // The relay's own body decides. A status on its own does not: something in front
      // of the relay answers 401 as well, and that must not cost the user their
      // pairing.
      const body = (await response.json().catch(() => null)) as {
        ticket?: string;
        code?: string;
      } | null;
      if (body && typeof body.ticket === 'string') return { kind: 'ticket', ticket: body.ticket };
      if (body && (body.code === 'UNAUTHORIZED' || body.code === 'DEVICE_REVOKED')) {
        return { kind: 'refused', code: body.code };
      }
      return { kind: 'none' };
    } catch {
      return { kind: 'none' };
    }
  }

  connect(): void {
    if (this.closed) return;
    this.setStatus('connecting');
    this.opened = false;
    // A new connection starts with nothing held. The frames of a replay that was cut
    // short are asked for again, because the cursor never moved past them.
    this.dropHeld();
    // The socket is opened with a ticket when the relay offers one, so the
    // long-lived token does not travel in the URL.
    void this.open();
  }

  /**
   * Throws away the frames of a replay that was never applied.
   *
   * The cursor does not move when this happens, so the relay is asked for those
   * frames again the next time the phone connects.
   */
  private dropHeld(): void {
    this.held = [];
    this.holding = false;
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private async open(): Promise<void> {
    const outcome = await this.fetchTicket();
    if (this.closed) return;
    if (outcome.kind === 'refused') {
      // The relay refused this phone, in its own words and with its own status. There
      // is nothing to retry: the phone has to be paired again.
      this.closed = true;
      this.setStatus('offline');
      this.options.onFatal?.(CLOSE_UNAUTHORIZED);
      return;
    }
    this.openSocket(outcome.kind === 'ticket' ? outcome.ticket : null);
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
      // A connection that worked is a fresh start for the ticket fallback: the relay
      // knows what a ticket is now, and a later failure may be worth one more try with
      // the token.
      this.usedTokenFallback = false;
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
      this.applyFrame(frame);
    };

    socket.onclose = (event) => {
      this.socket = null;
      this.setStatus('offline');
      if (this.closed) return;
      // A connection that was refused before it opened, and that carried a
      // ticket, is tried once more with the token: a relay whose room predates
      // the ticket does not know what one is, and it refuses a ticket the same way
      // it refuses a credential it does not accept. The fallback is one-shot, so a
      // relay that refuses the token as well ends the attempt.
      if (!this.opened && ticket && !this.usedTokenFallback) {
        this.usedTokenFallback = true;
        this.openSocket(null);
        return;
      }
      // A revoked or replaced device must stop trying: reconnecting forever with a
      // credential the relay has already rejected is a loop the user cannot see.
      // The token carried the credential on the second attempt, so this is the relay's
      // own verdict on it.
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
      // `onclose` always follows, so the reconnect is scheduled there. An error says
      // nothing about whether the credential was refused: the relay says that with a
      // close code, or with the status of the ticket request.
    };
  }

  /**
   * Applies one frame that arrived from the relay.
   *
   * The relay's hello carries the number its sequence counter has reached. When
   * that number is *below* the one this phone has already seen, the relay's
   * counter was rewound — the relay lost its state and started again. The phone
   * rewinds with it and asks for a fresh view, because a phone whose cursor sits
   * above the relay's counter silently drops every frame the relay sends next:
   * their numbers are all below its cursor, so they are discarded without a word
   * and the conversation simply stops arriving.
   *
   * The other direction matters too. The relay hands out its numbers one at a
   * time, so a number that is more than one above the cursor means frames were
   * lost between the relay and this phone. They cannot be got back — the relay's
   * replay buffer only covers the frames around its own counter — so the phone's
   * view has a hole in it and has to be rebuilt rather than carry on across the
   * gap.
   */
  private applyFrame(frame: Frame): void {
    if (frame.type === 'hello.ok') {
      this.attempt = 0;
      const payload = frame.payload as
        | { seq?: number; truncated?: boolean; bridgeOnline?: boolean }
        | undefined;
      this.bridgeOnline = payload?.bridgeOnline === true;
      // The relay says whether it could replay everything this phone missed. If
      // it could not, the first frame after the hello may jump, and that jump is
      // the one the relay already told the phone about.
      this.replayWasIncomplete = payload?.truncated === true;
      // Until the hello has been seen, the phone's cursor and the relay's
      // counter say nothing about each other, so a jump between them means
      // nothing and is not a loss.
      this.resumeSettled = true;
      const relaySeq = payload?.seq;
      if (typeof relaySeq === 'number' && relaySeq < this.lastSeq) {
        this.lastSeq = relaySeq;
        // The view has a hole in it, so the app is told to rebuild it.
        frame = { ...frame, payload: { ...payload, truncated: true } };
      }
      // The relay is about to replay the frames this phone missed. They are held until
      // the whole replay has arrived, so the phone's view is rebuilt in one step
      // instead of passing through the states the room was in on the way.
      this.replayTarget = typeof relaySeq === 'number' ? relaySeq : 0;
      this.holding = this.replayTarget > 0;
      this.receivedSeq = this.lastSeq;
      // The hello itself is not part of the replay: the app needs it now, because it
      // is the frame that says whether the phone's view is complete.
      this.options.onFrame?.(frame);
      return;
    }
    // A frame the relay has already sequenced is one the app has already applied.
    if (typeof frame.seq === 'number') {
      if (frame.seq <= this.lastSeq) return;
      if (frame.seq > this.receivedSeq + 1 && this.resumeSettled && !this.replayWasIncomplete) {
        // The relay's numbers jumped, so frames were lost on the way here. The
        // phone cannot get them back, so it rebuilds its view instead of
        // carrying on with a hole in the conversation.
        this.flushHeld();
        this.resync(frame.seq);
      }
      this.replayWasIncomplete = false;
      this.receivedSeq = frame.seq;
    }
    if (this.holding) {
      // Everything that arrives while the replay is held is held with it, so the
      // phone's view is rebuilt in the order the frames were sent.
      this.held.push(frame);
      // The replay ends at the number the relay's hello carried. A frame without a
      // number is not part of it: it is the answer to something the app asked for.
      const last = typeof frame.seq === 'number' ? frame.seq >= this.replayTarget : true;
      if (last) this.flushHeld();
      else this.armHoldTimer();
      return;
    }
    if (typeof frame.seq === 'number') this.lastSeq = frame.seq;
    this.options.onFrame?.(frame);
  }

  /**
   * Applies the frames the relay replayed, all at once.
   *
   * The phone's view is rebuilt in one step, so the states the room passed through
   * on the way are not shown one after the other, and the cursor only moves once
   * the app has actually been given the frames.
   */
  private flushHeld(): void {
    this.holding = false;
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    const frames = this.held;
    this.held = [];
    for (const frame of frames) {
      if (typeof frame.seq === 'number') this.lastSeq = frame.seq;
      this.options.onFrame?.(frame);
    }
  }

  /**
   * Gives a replay the relay could not finish a moment to arrive.
   *
   * A relay whose buffer no longer holds everything this phone missed cannot say
   * which frame ends the replay, so the held frames are applied once the room has
   * been quiet for a moment.
   */
  private armHoldTimer(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.holding) this.flushHeld();
    }, HOLD_FLUSH_MS);
  }

  /**
   * Asks the app to rebuild its view.
   *
   * The hello is the frame that carries "your view has a hole", so the one the
   * relay sends is sent again with that flag set: the app already knows what to
   * do with it.
   *
   * @param relaySeq the number the relay has reached, as the hello carries it.
   */
  private resync(relaySeq: number): void {
    this.resyncCounter += 1;
    this.options.onFrame?.({
      v: 1,
      id: `resync_${this.resyncCounter}`,
      ts: Date.now(),
      type: 'hello.ok',
      source: 'relay',
      payload: { seq: relaySeq, bridgeOnline: this.bridgeOnline, truncated: true },
    });
  }

  disconnect(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dropHeld();
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
