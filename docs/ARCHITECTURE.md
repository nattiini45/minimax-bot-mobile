# Architecture

Three components plus one shared contract, spread across four packages.

```
┌──────────────────────────┐
│  PHONE                   │  apps/app — Expo / React Native
│  Expo app                │  iOS · Android · PWA from one codebase
└───────────┬──────────────┘
            │  WSS, device token
            ▼
┌──────────────────────────┐
│  RELAY                   │  packages/relay — Cloudflare Worker + Durable Object
│  Worker + DO             │  pairing · fan-out · resume · presence
└───────────┬──────────────┘
            │  WSS, bridge token
            ▼
┌──────────────────────────┐
│  BRIDGE                  │  packages/bridge — MiniMax Code Mini App plugin
│  minimax-bot-bridge      │  agent turns · team tools · approvals · ledger
└───────────┬──────────────┘
            │  Mini App capability surface
            ▼
┌──────────────────────────┐
│  @minimax-bot            │  official plugin (read only, never modified)
│  team tools + agent      │
└──────────────────────────┘
```

`packages/protocol` is the shared contract: frame types, opcodes, events and the
pairing vocabulary. It is imported by the relay and the app as a workspace package, and
vendored into the bridge artifact because a Mini App runs with no module resolution.

## Why the bridge is a Mini App

Bot turns need `session.run`. That capability is granted only through the Mini App
surface (`agentAccess: ["session.run"]` in the manifest), so a standalone Node process
cannot drive a turn at all. The bridge is therefore a Mini App plugin.

A Mini App can only bind loopback (`MiniAppContext.listen.host` is typed `'127.0.0.1'`),
so the desktop can never be dialled by the phone. The bridge therefore **dials out** to
the relay over WSS, exactly like MiniMax's own Remote Control producer does. Node 22+
ships a global `WebSocket`, so the outbound leg needs no dependency.

## What the bridge does

1. **Links the team.** At start it calls `context.tool.list()` and keeps the catalogue of
   `mcp__minimax-bot__*` tools. The catalogue is published to the app, so the app renders
   what the team actually exposes rather than a hardcoded list.
2. **Runs turns.** `context.agent.run({ text, sessionId })` with an `onEvent` observer.
   The agent's events (`text.delta`, `message.committed`, `tool.started`,
   `tool.finished`, `permission.requested`, `question.requested`, `turn.finished`) are
   translated into protocol events and published.
3. **Calls team tools.** `context.tool.call({ name, arguments, signal })`. Arguments are
   mapped onto the tool's live `inputSchema` — see "Schema-driven arguments" below.
4. **Holds approvals.** A turn that stops for a permission check or a questionnaire is
   held by the desktop, not by the socket, and is re-emitted when a phone resumes.
5. **Keeps a ledger.** Tool receipts carry token usage, so the bridge reconstructs the
   usage numbers the desktop Mini App serves from its own store.

## Schema-driven arguments

The `@minimax-bot` MCP server's parameter names are not readable from outside a Mini App:
the loopback credential is issued per WebContents and injected only for the registered
tab. The bridge therefore never hardcodes them. It reads each tool's `inputSchema` from
the live catalogue and maps the operation payload onto it, using an alias table
(`botId` → `to` / `bot_id` / `target`, `text` → `message` / `content`, …). When a
required property cannot be satisfied the bridge refuses with `INVALID_ARGUMENTS` and
returns the schema so the client can ask for the exact missing field.

`packages/bridge/miniapp/node/tools.mjs` holds the alias table and the mapper, and
`packages/bridge/test/tools.test.mjs` covers it.

## Relay design

One Durable Object per account. It owns the pairing codes, the device credentials, the
socket registry and the event ring.

- **Pairing.** The bridge asks for a six digit code (90 s, single use). The phone types
  it; the relay exchanges it for a device token signed with a shared HMAC key.
- **Fan-out.** The relay stamps a monotonic `seq` on every bridge event and buffers the
  tail in a ring (512 entries and 4 MB by default). A frame larger than 512 KB is
  dropped before it is parsed, and the count of dropped frames is reported in the
  account's status.
- **Resume.** A reconnecting device sends its last `seq`; the relay replays what it
  missed and sets `truncated` when the device fell behind the buffer, which tells the app
  to resynchronise from a full snapshot.
- **Idempotency.** Operations carry an `opId`. The bridge keeps a ten minute dedupe
  cache, so a replay after a reconnect never sends a message twice.
- **Opacity.** The relay never interprets a payload. It only routes, orders and
  sequences frames.

## Ownership

| Concern | Owner | Rule |
|---|---|---|
| Conversation truth | Bridge (desktop) | The phone is a projection. |
| Turn execution | Bridge | A turn survives the phone disconnecting, the app being killed and the relay restarting. |
| Frame ordering | Relay | Monotonic `seq`; a client only applies `seq > lastApplied`. |
| Idempotency | Bridge | `opId` dedupe window of ten minutes. |
| Concurrency | Bridge | The Host allows 32 concurrent agent runs; the bridge queues beyond that. |
| Approvals | Bridge | Held server side with a ten minute TTL and re-emitted on resume. |
| Offline | App | An outbox queues composed messages and flushes on reconnect. |
| Reconnect | App + relay | Backoff 1/2/4/8/16/30 s with jitter; `last_seq` resume. |

## Package layout

```
packages/
  protocol/    frame envelope, opcodes, events, pairing vocabulary
  relay/       Worker + Durable Object, and the framework-agnostic RelaySession
  bridge/      the Mini App plugin (node artifact + a small desktop surface)
apps/
  app/         the Expo client
docs/          this documentation
```

The relay's behaviour lives in `RelaySession`, which has no Cloudflare dependency, so
it is unit tested without a runtime. The Durable Object is a thin adapter over it.

## Verification

- `npm run test:unit` — protocol and relay (vitest).
- `npm run test:bridge` — bridge (node:test, mirroring the official plugin's style).
- `npm run test:app` — the client store (jest + jest-expo).
- `npm run typecheck` — every workspace.
- `npm run export:web` — bundles the app for the PWA target.

The one thing that cannot be driven from a script is the bridge's own HTTP surface,
because the loopback credential is injected by the Host for its own tab only. The
live handshake with a running `@minimax-bot` runtime *can* be exercised: the bridge
reads each tool's schema at runtime and calls the real tools. See `docs/PAIRING.md`.
