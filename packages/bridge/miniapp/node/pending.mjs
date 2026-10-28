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
    /** @type {Map<string, {kind: 'permission'|'question', request: object, sessionId: string, expiresAt: number}>} */
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
