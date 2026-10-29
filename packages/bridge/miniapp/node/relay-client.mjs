/**
 * Outbound WebSocket link to the relay.
 *
 * The bridge dials out, exactly like MiniMax's own Remote Control producer: a Mini App
 * can only listen on loopback, so the desktop must be the one to open the connection.
 * Reconnection uses the same escalating backoff, and every attempt presents the same
 * credential because the relay's bridge token is long-lived.
 */

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_QUEUE = 200;

/**
 * The relay address, in the form each transport needs.
 *
 * The pairing request is an HTTP POST and the frame channel is a WebSocket, but the
 * operator is given a single address and the scheme they type must not decide which
 * one works: a `wss://` address cannot be fetched — `fetch` refuses a scheme that is
 * not HTTP — and an `http://` address is not a WebSocket URL. The two are translated
 * into each other instead.
 *
 * The translations are string operations on purpose: the same rule has to hold in a
 * browser, where `URL` is not a real URL parser.
 */

const TO_HTTP = {
  'http:': 'http:',
  'https:': 'https:',
  'ws:': 'http:',
  'wss:': 'https:',
};

const TO_WS = {
  'http:': 'ws:',
  'https:': 'wss:',
  'ws:': 'ws:',
  'wss:': 'wss:',
};

/**
 * @param {string} url
 * @param {Record<string, string>} schemes
 * @returns {string}
 */
function translate(url, schemes) {
  const trimmed = String(url).trim().replace(/\/+$/, '');
  const match = /^([a-z][a-z0-9+.-]*:)/i.exec(trimmed);
  if (!match) return trimmed;
  const scheme = match[1].toLowerCase();
  const target = schemes[scheme];
  if (!target) return trimmed;
  return target + trimmed.slice(scheme.length);
}

/**
 * @typedef {object} RelayLogger
 * @property {(message: string, meta?: unknown) => void} info
 * @property {(message: string, meta?: unknown) => void} warn
 * @property {(message: string, meta?: unknown) => void} error
 * @property {(message: string, meta?: unknown) => void} debug
 */

/**
 * @typedef {object} RelayClientOptions
 * @property {string} [url] Public base URL of the relay.
 * @property {string} [accountId] Room the bridge and its phones share.
 * @property {string} [bridgeId] Stable id of this desktop.
 * @property {string} [token] HMAC token the relay accepts for this bridge.
 * @property {string} [name] Display name shown on the phone.
 * @property {RelayLogger} [logger]
 * @property {(frame: any) => void} [onFrame]
 * @property {(connected: boolean) => void} [onStatus]
 */

export class RelayClient {
  /**
   * @param {RelayClientOptions} [options]
   */
  constructor({ url, accountId, bridgeId, token, name, logger, onFrame, onStatus } = {}) {
    this.url = url;
    this.accountId = accountId;
    this.bridgeId = bridgeId;
    this.token = token;
    this.name = name ?? 'Desktop';
    this.logger = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
    this.onFrame = onFrame ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.socket = null;
    this.closed = false;
    this.attempt = 0;
    this.queue = [];
    this.timer = null;
  }

  get connected() {
    return this.socket !== null && this.socket.readyState === 1;
  }

  get configured() {
    return Boolean(this.url && this.accountId && this.bridgeId && this.token);
  }

  /** The relay address as an HTTP origin, for the REST calls. */
  httpUrl() {
    return translate(this.url ?? '', TO_HTTP);
  }

  /** The relay address as a WebSocket origin, for the frame channel. */
  wsUrl() {
    return translate(this.url ?? '', TO_WS);
  }

  endpoint() {
    const base = this.wsUrl();
    const params = new URLSearchParams({
      role: 'bridge',
      subject: this.bridgeId,
      token: this.token,
      name: this.name,
    });
    return `${base}/r/${encodeURIComponent(this.accountId)}/ws?${params.toString()}`;
  }

  start() {
    if (!this.configured) {
      this.logger.warn('relay is not configured yet');
      return;
    }
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already gone */
      }
      this.socket = null;
    }
    this.onStatus(false);
  }

  connect() {
    if (this.closed) return;
    const WebSocketImpl = globalThis.WebSocket;
    if (!WebSocketImpl) {
      this.logger.error('this runtime has no WebSocket client');
      return;
    }

    let socket;
    try {
      socket = new WebSocketImpl(this.endpoint());
    } catch (error) {
      this.logger.error(`relay connection failed: ${error instanceof Error ? error.message : error}`);
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.onStatus(true);
      this.flush();
    });

    socket.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      try {
        this.onFrame(JSON.parse(raw));
      } catch {
        this.logger.warn('relay sent a frame that is not valid JSON');
      }
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      this.onStatus(false);
      if (!this.closed) this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // `close` always follows, so the reconnect is scheduled there.
    });
  }

  scheduleReconnect() {
    if (this.closed || this.timer) return;
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    const jitter = Math.floor(Math.random() * 400);
    this.attempt += 1;
    const delay = base + jitter;
    this.logger.info(`reconnecting to the relay in ${delay} ms`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    if (typeof this.timer?.unref === 'function') this.timer.unref();
  }

  /** Sends a frame. Frames queued while offline are flushed on reconnect. */
  send(frame) {
    const raw = JSON.stringify(frame);
    if (this.connected) {
      try {
        this.socket.send(raw);
        return true;
      } catch {
        /* fall through to the queue */
      }
    }
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
    }
    this.queue.push(raw);
    return false;
  }

  flush() {
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

  /**
   * Asks the relay for a pairing code.
   *
   * The code is shown on the desktop and typed into the phone. It is single use and
   * short-lived, so it is never persisted by the bridge.
   *
   * @returns {Promise<{ code: string, expiresAt: number }>}
   */
  async createPairingCode() {
    if (!this.configured) {
      throw new Error('The relay is not configured yet.');
    }
    const base = this.httpUrl();
    const response = await fetch(`${base}/r/${encodeURIComponent(this.accountId)}/pair/code`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ bridgeId: this.bridgeId, bridgeName: this.name }),
    });
    if (!response.ok) {
      throw new Error(`The relay refused the pairing request (${response.status}).`);
    }
    const body = /** @type {{ code: string, expiresAt: number }} */ (await response.json());
    return body;
  }

  /** Lists the devices paired with this bridge. */
  async listDevices() {
    if (!this.configured) return [];
    const base = this.httpUrl();
    const response = await fetch(`${base}/r/${encodeURIComponent(this.accountId)}/devices`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) return [];
    const body = /** @type {{devices?: unknown}} */ (await response.json());
    return Array.isArray(body.devices) ? body.devices : [];
  }

  /** Revokes a paired device. */
  async revokeDevice(deviceId) {
    if (!this.configured) return false;
    const base = this.httpUrl();
    const response = await fetch(
      `${base}/r/${encodeURIComponent(this.accountId)}/devices/${encodeURIComponent(deviceId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${this.token}` } },
    );
    return response.ok;
  }

  /**
   * Asks the relay for a fresh token.
   *
   * The relay signs it — it holds the shared secret — and every older bridge token
   * for this account stops working at the same moment. That is what makes a leaked
   * token revocable: it is not enough to change the token, the old one has to die.
   *
   * @returns {Promise<string>} the new token
   */
  async rotateToken() {
    if (!this.configured) throw new Error('the relay is not configured');
    const base = this.httpUrl();
    const response = await fetch(
      `${base}/r/${encodeURIComponent(this.accountId)}/bridge/token`,
      { method: 'POST', headers: { authorization: `Bearer ${this.token}` } },
    );
    if (!response.ok) {
      throw new Error(`The relay refused the token rotation (${response.status}).`);
    }
    const body = /** @type {{token?: string}} */ (await response.json());
    if (!body.token) throw new Error('The relay did not return a token.');
    this.token = body.token;
    return body.token;
  }

  /**
   * When the current token expires, epoch ms — or null when that cannot be read.
   *
   * The token is signed, not encrypted: its payload is readable, so the bridge can
   * tell that the token is about to run out without asking anyone.
   *
   * @returns {number | null}
   */
  tokenExpiresAt() {
    if (!this.token) return null;
    const [body] = this.token.split('.');
    if (!body) return null;
    try {
      const padded = body.replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
      return typeof payload.exp === 'number' ? payload.exp : null;
    } catch {
      return null;
    }
  }
}
