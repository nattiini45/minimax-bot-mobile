# minimax-bot-mobile

A native mobile client for a [`@minimax-bot`](https://github.com/nattiini45) team —
one codebase, three targets: **iOS**, **Android** and **PWA**.

Not a chat box with a bot behind it. The whole team surface — bots, groups,
chats, dispatch, tasks, helpers, memory, schedules, usage, approvals — in the
MiniMax design language, with the interaction quality you would expect from a
native app.

```
┌──────────────────────────┐
│  PHONE                   │  apps/app — Expo / React Native
│  iOS · Android · PWA     │  expo-router, zustand, the MiniMax skin
└───────────┬──────────────┘
            │  WSS, device token
            ▼
┌──────────────────────────┐
│  RELAY                   │  packages/relay — Cloudflare Worker + DO
│  pairing · fan-out       │  routes, orders and sequences frames
└───────────┬──────────────┘
            │  WSS, bridge token
            ▼
┌──────────────────────────┐
│  BRIDGE                  │  packages/bridge — MiniMax Code Mini App
│  minimax-bot-bridge      │  runs turns, calls team tools, holds approvals
└───────────┬──────────────┘
            │  Mini App capability surface
            ▼
┌──────────────────────────┐
│  @minimax-bot            │  official plugin — read only, never modified
└──────────────────────────┘
```

## Why it is built this way

**The bridge is a Mini App.** Running a Bot turn needs `session.run`, and that
capability is granted only through the Mini App surface
(`agentAccess: ["session.run"]`). A standalone Node process cannot drive a turn at
all, so the bridge is a Mini App plugin — `packages/bridge`, separate from the
official `@minimax-bot` plugin, which is hash-verified and never touched.

**The bridge dials out.** A Mini App can only bind loopback
(`MiniAppContext.listen.host` is typed `'127.0.0.1'`), so the desktop can never be
dialled by a phone. The bridge opens the outbound WebSocket to the relay, exactly
like MiniMax's own Remote Control producer does.

**The relay is a dumb pipe.** It authenticates peers, stamps a monotonic `seq` on
every event, buffers the tail for resume, and fans out. It never interprets a
payload and never holds a MiniMax credential.

**Tool arguments are schema-driven.** The `@minimax-bot` MCP server's parameter
names are not readable from outside a Mini App, so the bridge never hardcodes
them. It reads each tool's live `inputSchema` and maps the operation payload onto
it with an alias table, refusing with `INVALID_ARGUMENTS` (plus the schema and the
missing properties) rather than guessing.

**The client is one codebase.** Expo + expo-router: the same React Native
components render on iOS, on Android and on the web through `expo export -p web`.

## Layout

```
packages/
  protocol/    frame envelope, opcodes, events, pairing vocabulary
  relay/       Worker + Durable Object, and the framework-agnostic RelaySession
  bridge/      the Mini App plugin (node artifact + desktop pairing surface)
apps/
  app/         the Expo client
docs/
  ARCHITECTURE.md     how the pieces fit and why
  PROTOCOL.md        the wire contract
  DESIGN-TOKENS.md   the MiniMax skin, token by token
  PAIRING.md         device pairing, credentials, troubleshooting
```

`packages/protocol` is imported as a workspace package by the relay and the app,
and vendored into the bridge artifact because a Mini App runs with no module
resolution. `packages/bridge/scripts/sync-protocol.mjs` performs that vendoring as
part of every build.

## Getting started

```bash
npm install
npm run build
npm test
```

Node 22.12+ is required (the bridge uses the global `WebSocket`). On a fresh
install npm may ask to approve lifecycle scripts for `esbuild`, `workerd`,
`@parcel/watcher` and `unrs-resolver`:

```bash
npm approve-scripts esbuild workerd @parcel/watcher unrs-resolver
```

### Run the client

```bash
npm run app -- --web       # PWA
npm run app -- --ios       # iOS simulator
npm run app -- --android   # Android emulator
```

Or from `apps/app` directly: `npm run web`, `npm run ios`, `npm run android`.

### Run the relay

```bash
cd packages/relay
npx wrangler secret put RELAY_SECRET
npx wrangler deploy
```

The Durable Object class must be exported from the Worker entrypoint
(`export { Relay } from './relay.js';`) or Wrangler cannot bind it.

### Run the bridge

The bridge is a Mini App plugin. Build it, then install `packages/bridge` as a
MiniMax Code plugin and open its surface at `/bridge`. It shows the relay
configuration, requests pairing codes and lists paired phones. See
[docs/PAIRING.md](docs/PAIRING.md).

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Compiles the protocol, bundles the relay, vendors the protocol into the bridge |
| `npm test` | Build, then bridge tests, unit tests and app tests |
| `npm run test:unit` | Protocol and relay (vitest) |
| `npm run test:bridge` | Bridge (node:test) |
| `npm run test:app` | Client store (jest + jest-expo) |
| `npm run typecheck` | Every workspace |
| `npm run export:web` | Bundles the client for the PWA target |
| `npm run app` | Starts the Expo dev server |

Two runner notes, both verified on Node 24:

- The bridge's tests are discovered by `node --test` with **auto-discovery** from
  `packages/bridge`. Passing a directory (`node --test test/`) fails with
  `MODULE_NOT_FOUND`.
- `packages/protocol/tsconfig.json` needs `"lib": ["ES2022", "DOM"]`, or `tsc`
  fails on the `Crypto` type.

## Tests

| Suite | Count | Runner |
|---|---|---|
| `packages/protocol` | 24 | vitest |
| `packages/relay` | 32 | vitest |
| `packages/bridge` | 37 | node:test |
| `apps/app` | 10 | jest + jest-expo |

## What the phone can do

- **Chats** with any Bot or group, with streaming deltas, tool activity, reactions
  and history.
- **Teams** — create, update and delete Bots and groups; main-Bot administration.
- **Dispatch** — fan a prompt out to several Bots and watch the tasks land.
- **Tasks and helpers** — start background work, stop it, follow its state.
- **Memory** — recall, remember and forget, per Bot.
- **Schedules** — daily, interval and one-shot jobs.
- **Approvals** — answer a permission request (`allowOnce` / `deny`) or a
  questionnaire from the phone.
- **Usage** — turns, characters, tool calls and errors, per bucket and per Bot.

## Known limitation

The live handshake between the bridge and a running `@minimax-bot` runtime cannot
be exercised from a workstation: the Mini App loopback credential is issued per
WebContents by the Electron Host and injected only for the registered tab, so the
live tool schemas are not introspectable externally. The schema-driven argument
mapping exists precisely because of this, and the first end-to-end run needs a
human in front of the desktop. Details in
[docs/PAIRING.md](docs/PAIRING.md#the-one-thing-that-cannot-be-tested-from-a-workstation).

## Attribution

By [@nattiini45](https://github.com/nattiini45) (and contributors).
