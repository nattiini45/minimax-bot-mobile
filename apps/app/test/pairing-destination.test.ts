import { pairWithCode } from '../src/net/pairing';

/**
 * Where the pairing code goes.
 *
 * The pairing code is a one-time credential: the relay exchanges it for a device token
 * that is good for a month. The address in the pairing form is free text, so a phone
 * that posts the code to whatever address is in the field hands that credential to
 * whoever is listening - and the listener can use it, or forward it to the real relay
 * and keep the token.
 *
 * These tests use only the pairing request itself, so they say what the code does
 * rather than how the decision is made.
 */

const CODE = '123456';

/** The relay this build was made for. */
const BUILD_ORIGIN = 'https://relay.example.workers.dev';

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, deviceToken: 'the-device-token', expiresAt: 1 }),
  });
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  delete (global as unknown as { fetch?: unknown }).fetch;
});

describe('sending the pairing code', () => {
  const base = {
    accountId: 'default',
    code: CODE,
    deviceId: 'phone-1',
    deviceName: 'Phone',
    clientVersion: '0.1.0',
  };

  it('sends the code to the relay the phone knows', async () => {
    const result = await pairWithCode({
      ...base,
      url: BUILD_ORIGIN,
      known: { buildOrigin: BUILD_ORIGIN },
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BUILD_ORIGIN}/r/default/pair`);
  });

  it('does not send the code to a relay the phone does not know', async () => {
    const result = await pairWithCode({
      ...base,
      url: 'https://other.example.workers.dev',
      known: { buildOrigin: BUILD_ORIGIN, lastOrigin: BUILD_ORIGIN },
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNTRUSTED_RELAY');
    // The code did not leave the phone.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the code to that relay once the user has acknowledged it', async () => {
    const result = await pairWithCode({
      ...base,
      url: 'https://other.example.workers.dev',
      known: { buildOrigin: BUILD_ORIGIN, lastOrigin: BUILD_ORIGIN },
      confirmed: true,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://other.example.workers.dev/r/default/pair');
  });

  it('does not send the code to an address that is not a relay at all', async () => {
    const result = await pairWithCode({
      ...base,
      url: 'not a url',
      known: { buildOrigin: BUILD_ORIGIN },
      confirmed: true,
    });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not send the code to an address that hides its host behind a userinfo part', async () => {
    // This address reaches `evil.example` while it reads like the trusted relay.
    const result = await pairWithCode({
      ...base,
      url: 'https://relay.example.workers.dev@evil.example',
      known: { buildOrigin: BUILD_ORIGIN },
      confirmed: true,
    });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
