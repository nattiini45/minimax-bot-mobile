/**
 * Pending approvals and questions.
 *
 * A turn that stops for a permission check or a questionnaire is held by the desktop, not
 * by the socket, so the phone can answer it minutes later — or after a reconnect. The
 * pending set is re-emitted whenever a device resumes so a phone that was offline still
 * sees the request.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class PendingSet {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, {kind: 'permission'|'question', request: object, sessionId: string, expiresAt: number, claimed?: boolean}>} */
    this.items = new Map();
  }

  add(kind, request, sessionId) {
    const expiresAt = this.now() + this.ttlMs;
    this.items.set(request.requestId, { kind, request, sessionId, expiresAt });
    return { ...request, expiresAt };
  }

  get(requestId) {
    this.expire();
    return this.items.get(requestId);
  }

  /**
   * Claims a request for an answer.
   *
   * The claim is taken before the Host is called, so a second answer to the same
   * request finds nothing to answer and is refused. Without the claim, both answers
   * pass the lookup and both reach the Host, and a phone that double-taps the approve
   * button produces two answers rather than one.
   *
   * @param {string} requestId
   * @param {'permission'|'question'} [kind]
   * @returns the claimed item, or undefined when there is nothing to claim
   */
  claim(requestId, kind) {
    this.expire();
    const item = this.items.get(requestId);
    if (!item) return undefined;
    if (kind && item.kind !== kind) return undefined;
    if (item.claimed) return undefined;
    item.claimed = true;
    return item;
  }

  /**
   * Gives a claimed request back, so that it can be answered again.
   *
   * This is for the case where the Host did not take the answer: the request is still
   * waiting for one, and the phone is allowed to give it.
   *
   * @param {string} requestId
   */
  release(requestId) {
    const item = this.items.get(requestId);
    if (!item) return false;
    item.claimed = false;
    return true;
  }

  resolve(requestId) {
    this.expire();
    return this.items.delete(requestId);
  }

  list(kind) {
    this.expire();
    const all = [...this.items.values()];
    return kind ? all.filter((item) => item.kind === kind) : all;
  }

  /** Drops expired requests. Returns the ids that were removed. */
  expire() {
    const now = this.now();
    const removed = [];
    for (const [id, item] of this.items) {
      if (item.expiresAt <= now) {
        this.items.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  get size() {
    this.expire();
    return this.items.size;
  }
}
