# Pairing

The phone never sees a MiniMax credential. It holds one device-scoped token that the
relay issued, and that the desktop can revoke at any moment.

## The shape of it

```
DESKTOP (bridge)                        RELAY                    PHONE
      │                                    │                        │
      │ POST /r/:acct/pair/code            │                        │
      │   Authorization: Bearer <bridge>   │                        │
      ├───────────────────────────────────>│                        │
      │ { code: "418902", expiresAt }      │                        │
      │<───────────────────────────────────┤                        │
      │                                    │                        │
      │        (the user reads the code)   │   POST /r/:acct/pair   │
      │                                    │<───────────────────────┤
      │                                    │ { code, deviceId }     │
      │                                    ├───────────────────────>│
      │                                    │ { deviceToken, expiresAt }
      │                                    │<───────────────────────┤
```

The relay holds no MiniMax account credential. It only knows device ids, bridge
ids and HMAC-signed tokens.

## Step by step

### 1. The desktop asks for a code

The bridge calls `POST /r/:accountId/pair/code` with its own bearer token. The
relay verifies the token (`role: bridge`, `sub` must equal the bridge id) and
returns a six digit code that expires in **90 seconds** and is **single use**.

The bridge never persists the code. It shows it on the desktop surface
(`packages/bridge/miniapp/client/index.html`) and forgets it.

### 2. The phone types the code

The phone opens `app/pair.tsx`, enters the relay URL and account id, and types the
six digits. The client validates the shape locally first (`isValidPairingCode`,
digits only, exactly six) so a typo never reaches the relay.

### 3. The relay exchanges the code

`POST /r/:accountId/pair` with `{ code, deviceId, deviceName, clientVersion }`.

The relay looks the code up **before** pruning expired codes, so a stale code is
reported as `PAIRING_CODE_EXPIRED` rather than `PAIRING_CODE_UNKNOWN` — the phone
needs to know whether to ask the desktop for a new code or whether it typed it
wrong. The code is consumed the instant it is claimed.

On success the relay issues a device token: `base64url(payload).base64url(sig)`,
HMAC-SHA-256 over the shared secret, with a 30 day expiry.

### 4. The phone connects

The phone opens `GET /r/:accountId/ws?role=device&subject=<deviceId>&token=…&lastSeq=…`.
The relay verifies the token, checks that the device record exists, is not revoked,
and still matches the presented token, then replays the frames the device missed.

### 5. Revoking

The desktop lists paired devices and revokes any of them
(`DELETE /r/:accountId/devices/:deviceId`). A revoked device's token stops
verifying immediately, and its live socket is closed with code `4003`. The phone
sees the drop, fails to reconnect, and returns to the pairing screen.

## Credentials

| Credential | Held by | Lifetime | Revocable |
|---|---|---|---|
| Bridge token | The desktop's bridge config | long-lived | by rotating `RELAY_SECRET` |
| Device token | The phone's secure storage | 30 days | yes, from the desktop |
| Pairing code | neither (transient) | 90 s, single use | it just expires |
| MiniMax account | the desktop only | — | — |

Token payload:

```jsonc
{ "v": 1, "sub": "<deviceId | bridgeId>", "role": "device | bridge",
  "exp": 1793181000000, "jti": "<unique id>" }
```

`verifyToken` returns `null` for anything malformed, wrongly signed, expired, or
carrying an unknown role. Callers treat `null` as "not authorized" — never as a
partial success.

## Configuration

The bridge stores its configuration in `bridge-config.json` inside the Mini App's
data directory:

```jsonc
{
  "relayUrl": "wss://relay.example.workers.dev",
  "accountId": "default",
  "bridgeId": "bridge_9f2c…",   // generated once, then stable
  "bridgeToken": "<hmac token>",
  "bridgeName": "Desktop"
}
```

The `bridgeId` is generated on first run and persisted, because the relay pairs a
phone against a *specific* desktop: after a restart the phone has to find the same
bridge again.

The relay's shared secret is the Worker secret `RELAY_SECRET`:

```bash
npx wrangler secret put RELAY_SECRET --config packages/relay/wrangler.toml
```

The same secret must produce the bridge token on the desktop and verify it on the
relay.

## Deployed relay

```bash
cd packages/relay
npx wrangler deploy
```

`packages/relay/wrangler.toml` binds the Durable Object class and points the
`RELAY` namespace at it. The Durable Object class must be exported from the
Worker entrypoint (`export { Relay } from './relay.js';`) or Wrangler cannot bind
it.

## What the relay does not do

- It does not interpret payloads. It routes, orders and sequences frames.
- It does not hold a MiniMax credential.
- It does not keep a conversation. Conversation truth lives on the desktop; the
  phone is a projection of it.
- It does not relay a bridge frame to a device that has not authenticated.

## Troubleshooting

**"That pairing code expired."**
The code lives 90 seconds. Ask the desktop for a new one and type it immediately.

**"No bridge is waiting for that code."**
Either the code was already used (it is single use), or the desktop is not
connected to this relay, or the `accountId` on the phone does not match the one on
the desktop. Check `/r/:accountId/status` — `bridgeOnline` tells you which.

**"This device is not paired with this bridge."**
The device token is stale or was revoked. Pair again from the phone.

**"The desktop is offline."**
`bridgeOnline` is false: MiniMax Code is not running, or the bridge plugin is not
loaded, or the relay URL in the bridge config is wrong.

**The phone connects but no messages arrive.**
The bridge is online and the socket is open, but the tool catalogue is empty. The
bridge publishes `diagnostics` in `evt.team_snapshot`; `teamToolsAvailable: false`
means the `@minimax-bot` MCP server did not answer a tool listing — usually because
the plugin is still starting. The phone's `teamToolsAvailable` flag mirrors this.

**The phone connects, but the wrong parameter names fail.**
They should not: the bridge maps arguments from each tool's live `inputSchema`
rather than hardcoding names. If a call still fails with `INVALID_ARGUMENTS`, the
response carries the schema and the missing properties — that is the signal to
extend the alias table in `packages/bridge/miniapp/node/tools.mjs`.

## What cannot be driven from a script

The bridge's **own** HTTP surface (`/api/session`, `/api/config`) sits behind the
Host's per-WebContents loopback credential (`x-mavis-miniapp-token`), which is issued
per WebContents by the Electron Host and injected only for the registered tab — it is
never written to disk. Probing the Mini App server from outside returns HTTP 401.

So the bridge cannot be *configured* from a script: the configuration is written into
the bridge's data directory instead, and the pairing code is requested over the
relay by a client that holds the bridge token.

Everything else can be driven from a script, and is: the relay accepts a device
peer, a device peer can send operations, and the bridge answers them by calling the
real `@minimax-bot` tools. The live tool schemas are read at runtime rather than
hardcoded for exactly this reason — a script never sees them, and neither should the
bridge.

## The end-to-end run

The pieces line up like this, and each step has been run against the real thing
rather than a stand-in:

1. The relay runs (`npm run mint:token` mints a bridge token for it).
2. The bridge Mini App runs inside MiniMax Code and dials the relay.
3. The bridge asks the relay for a pairing code; the phone types it in.
4. The phone asks the bridge for the team roster; the bridge calls `list_team`.
5. The phone chats with a Bot; the bridge runs the turn through `session.run`.

Steps 4 and 5 are the ones that need a human: the bridge can only be told to call a
tool from inside the Mini App, and a turn has to be started from the desktop side.

