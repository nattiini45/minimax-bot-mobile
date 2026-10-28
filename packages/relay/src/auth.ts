/**
 * Token signing for relay peers.
 *
 * The relay never holds a MiniMax account credential. It issues device-scoped tokens
 * signed with a shared HMAC key, and the bridge signs its own token the same way. Both
 * sides only need to prove they are who the relay paired them as.
 */

export type PeerRole = 'bridge' | 'device';

export interface TokenPayload {
  v: 1;
  /** Subject: the bridge id or the device id. */
  sub: string;
  role: PeerRole;
  /** Expiry, epoch ms. */
  exp: number;
  /** Unique token id. */
  jti: string;
}

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const base64 = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // Copy into a fresh ArrayBuffer: `Buffer` is backed by `ArrayBufferLike`, which the
  // WebCrypto `BufferSource` overloads reject.
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  return subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Signs a token payload. The result is `base64url(payload).base64url(signature)`. */
export async function signToken(payload: TokenPayload, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verifies a token.
 *
 * Returns `null` for anything that is not a well-formed, correctly signed, unexpired
 * token. Callers must treat `null` as "not authorized" and never as a partial success.
 */
export async function verifyToken(token: string, secret: string): Promise<TokenPayload | null> {
  if (typeof token !== 'string' || token.length === 0) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let valid = false;
  try {
    const key = await hmacKey(secret);
    valid = await globalThis.crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(signature),
      encoder.encode(body),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as TokenPayload;
  } catch {
    return null;
  }

  if (!payload || payload.v !== 1) return null;
  if (payload.role !== 'bridge' && payload.role !== 'device') return null;
  if (typeof payload.sub !== 'string' || !payload.sub) return null;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
  if (payload.exp <= Date.now()) return null;

  return payload;
}

/** Builds and signs a token in one step. */
export async function issueToken(
  sub: string,
  role: PeerRole,
  ttlMs: number,
  secret: string,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = now + ttlMs;
  const payload: TokenPayload = {
    v: 1,
    sub,
    role,
    exp: expiresAt,
    jti: newTokenId(now),
  };
  return { token: await signToken(payload, secret), expiresAt };
}

function newTokenId(now: number): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `${now.toString(36)}${Math.floor(Math.random() * 0xffffff).toString(16)}`;
}
