/**
 * Pairing and credential contract shared by the bridge, the relay and the app.
 *
 * The relay is a dumb pipe, so it never holds a MiniMax account credential. Pairing is a
 * one-time code exchange: the bridge asks the relay for a short code, the phone types it,
 * and the relay hands the phone a device-scoped token it can revoke from the desktop.
 */

export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_TTL_MS = 90_000;
export const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Only digits, so the code is easy to read off a phone screen and type. */
const PAIRING_CODE_PATTERN = new RegExp(`^\\d{${PAIRING_CODE_LENGTH}}$`);

export function isValidPairingCode(code: string): boolean {
  return PAIRING_CODE_PATTERN.test(code);
}

/** Generates a numeric pairing code with a uniform distribution. */
export function generatePairingCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    code += String(Math.floor(random() * 10));
  }
  return code;
}

/** The role a socket plays on the relay. */
export type PeerRole = 'bridge' | 'device';

export interface PairingRequest {
  code: string;
  /** Device id the phone wants to claim. */
  deviceId: string;
  deviceName: string;
  clientVersion: string;
}

export interface PairingResponse {
  ok: boolean;
  /** Present when `ok` is true. */
  deviceToken?: string;
  /** Epoch ms the token expires. */
  expiresAt?: number;
  /** Present when `ok` is false. */
  code?: string;
  message?: string;
}

export interface BridgeStatus {
  bridgeOnline: boolean;
  deviceId: string;
  deviceName: string;
  linkedAt?: number;
}

/** The relay's answer to a bridge's `hello`. */
export interface BridgeHelloRequest {
  bridgeId: string;
  bridgeToken: string;
  bridgeName: string;
  clientVersion: string;
}

export type RelayErrorCode =
  | 'UNAUTHORIZED'
  | 'PAIRING_CODE_INVALID'
  | 'PAIRING_CODE_EXPIRED'
  | 'PAIRING_CODE_UNKNOWN'
  | 'DEVICE_REVOKED'
  | 'BRIDGE_OFFLINE'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED';

export function describeRelayError(code: RelayErrorCode): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'This device is not paired with this bridge.';
    case 'PAIRING_CODE_INVALID':
      return 'That pairing code is not valid.';
    case 'PAIRING_CODE_EXPIRED':
      return 'That pairing code expired. Ask the desktop for a new one.';
    case 'PAIRING_CODE_UNKNOWN':
      return 'No bridge is waiting for that pairing code.';
    case 'DEVICE_REVOKED':
      return 'This device was revoked from the bridge.';
    case 'BRIDGE_OFFLINE':
      return 'The desktop is offline. Start MiniMax Code and try again.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Wait a moment and try again.';
    case 'BAD_REQUEST':
      return 'The request could not be understood.';
  }
}
