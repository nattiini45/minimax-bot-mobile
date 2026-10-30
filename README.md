# minimax-bot-mobile

A native mobile client for a [`@minimax-bot`](https://github.com/nattiini45) team —
one codebase, three targets: **iOS**, **Android** and **PWA**.

Not a chat box with a bot behind it. The whole team surface — bots, groups,
chats, dispatch, tasks, helpers, memory, schedules, usage, approvals — in the
MiniMax design language, with the interaction quality you would expect from a
native app.

> Built with **M3.1 Flash** in **MiniMax Code**. The engineering diary — the six
> real bugs the model found by working against a live team — is in
> [`docs/CREATION-NOTE.md`](docs/CREATION-NOTE.md).
>
> **Live client:** <https://n5qi7wnkhcwnd.space.minimax.io> ·
> [Demo video](https://github.com/nattiini45/minimax-bot-mobile/releases/download/v0.1.0/demo.mp4) ·
> [Android APK](https://github.com/nattiini45/minimax-bot-mobile/releases/download/v0.1.0/minimax-bot-mobile-release.apk) ·
> [Live tool trace](https://n5qi7wnkhcwnd.space.minimax.io/screenshot-trace.png)

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

### Put the relay on the public internet

The relay is a plain Worker, so `npx wrangler deploy` gives every phone one
address to reach — `https://<worker>.<subdomain>.workers.dev`. Two things make
that safe to publish:

- **Every route is authenticated.** An account's status — whether a desktop is
  attached to it, and how many phones are paired with it — is answered only to a
  credential that belongs to that account. Everything else needs a bearer token or
  a one-time pairing code; there is no cookie and no session to steal.
- **Guessing a pairing code is rate limited.** Ten wrong codes lock the endpoint
  for a minute, a code lives for ninety seconds, and it is consumed on use. An
  account belongs to one bridge: a second bridge cannot claim it.

Point the bridge at the deployed worker, mint a bridge token for it, and give
the phone the worker address:

```bash
RELAY_SECRET=<RELAY_SECRET> npm run mint:token -- --bridge-id <id> --bridge-name <name>
```

The secret comes from the environment (or from `--secret-file <path>`), never from
the command line: an argument lands in the shell history and in the process table.
The `--` before the options matters: npm would otherwise read them as its own.

The client can ship with the relay address already filled in. Expo inlines
`EXPO_PUBLIC_RELAY_URL` at build time, and the field stays editable, so a
self-hosted relay is still one tap away:

```bash
EXPO_PUBLIC_RELAY_URL=https://<worker>.<subdomain>.workers.dev npm run export:web
```

### Run the bridge

The bridge is a Mini App plugin. Build it, then install `packages/bridge` as a
MiniMax Code plugin and open its surface at `/bridge`. It shows the relay
configuration, requests pairing codes and lists paired phones. See
[docs/PAIRING.md](docs/PAIRING.md).

The bridge needs a **bridge token** to claim an account on the relay. Mint one
against the relay's secret:

```bash
RELAY_SECRET=<RELAY_SECRET> npm run mint:token -- --bridge-id bridge_1 --bridge-name MyDesktop --days 30
```

It prints the token, its expiry and the configuration block to paste into the
bridge's surface.

### Build the Android app

The Android release build **runs on Linux**. React Native's native build uses
`ninja`, which does not honour the long-path prefix that Windows' `LongPathsEnabled`
sets, so the generated object paths run past the 260-character limit no matter where
the repository lives — and RN 0.88 no longer accepts `newArchEnabled=false` as a way
out. A WSL2 distribution, a container or a CI runner all work.

```bash
# On Linux, with JDK 17 and the Android SDK on the path:
scripts/build-android.sh

# The whole workspace is copied, not just `apps/app`: the client bundles
# `@minimax-bot/protocol`, so a change in a workspace package that never reaches the
# build host produces an APK built against a contract it was not built with.
```

The output is `apps/app/android/app/build/outputs/apk/release/app-release.apk`.

### Cleartext: the release build has none

The app talks to its relay over TLS. A relay running on the developer's own
machine — `wrangler dev` on the laptop, reached from a device through
`adb reverse` — speaks plain HTTP on the loopback interface, and Android blocks
cleartext by default from API 28 onwards. So the two builds differ:

- **The release build forbids cleartext outright.** Its network security config
  (`src/main/res/xml/network_security_config.xml`) carries no exception at all,
  so the device token cannot travel in the clear in a build that anybody can
  install.
- **The development builds keep the loopback exception.** The same resource in
  the `debug` and `debugOptimized` source sets
  (`src/debug/res/xml/network_security_config.xml` and
  `src/debugOptimized/res/xml/network_security_config.xml`) permits cleartext
  for `localhost` and `127.0.0.1` only. Android merges the build-type source
  set over the main one, so the development builds get the exception and the
  release build gets the strict configuration. The resource has the same name in
  all of them, so the manifest does not have to change.

To reach a relay on your own machine from a device in development:

```bash
cd packages/relay && npx wrangler dev --port 8787
adb reverse tcp:8787 tcp:8787     # the device's localhost becomes the laptop's
```

Then point the phone at `http://localhost:8787`. A release build refuses that
address at the platform level, which is the point.

The React Native template's debug manifests carry `usesCleartextTraffic="true"`
so that the development builds can reach the Metro dev server. It does not
widen them: Android ignores that attribute from API 24 onwards whenever a
network security config is present, and this app's `minSdkVersion` is 24. The
release build does not inherit those manifests at all, so it has neither the
attribute nor the exception.

The build asserts every configuration rather than printing them:
`scripts/check-network-security-config.mjs` fails the build when the release
config would permit cleartext anywhere, and when a development config has lost
the loopback exception the local-relay workflow needs.

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
| `npm run mint:token` | Mints a bridge token for the relay |
| `npm run build:android` | Builds the Android release APK (on Linux) |

Two runner notes, both verified on Node 24:

- The bridge's tests are discovered by `node --test` with **auto-discovery** from
  `packages/bridge`. Passing a directory (`node --test test/`) fails with
  `MODULE_NOT_FOUND`.
- `packages/protocol/tsconfig.json` needs `"lib": ["ES2022", "DOM"]`, or `tsc`
  fails on the `Crypto` type.

## Tests

| Suite | Count | Runner |
|---|---|---|
| `packages/protocol` | 29 | vitest |
| `packages/relay` | 33 | vitest |
| `packages/bridge` | 74 | node:test |
| `apps/app` | 32 | jest + jest-expo |

## What the phone can do

- **Chats** with any Bot or group, with streaming deltas, tool activity, reactions
  and history.
- **A live trace of the team's work.** The bridge reports every tool the team runs
  while it answers, and the client shows them as they happen: which tool, how long
  it took, and whether it failed. A reply is a visible process, not a long silence.
- **Teams** — create, update and delete Bots and groups; main-Bot administration.
- **Dispatch** — fan a prompt out to several Bots and watch the tasks land.
- **Tasks and helpers** — start background work, stop it, follow its state.
- **Memory** — recall, remember and forget, per Bot.
- **Schedules** — daily, interval and one-shot jobs.
- **Approvals** — answer a permission request (`allowOnce` / `deny`) or a
  questionnaire from the phone.
- **Usage** — turns, characters, tool calls and errors, per bucket and per Bot.

## Try it in a browser

The client is an Expo app, so the same code runs as a PWA.

**The live client is running:** <https://n5qi7wnkhcwnd.space.minimax.io>

It talks to a relay that is deployed on the public internet
(<https://minimax-bot-relay.nattiini45.workers.dev>), so a stranger can open the link,
type the six-digit code the desktop shows and drive the real team. Nothing about the
browser build is a demo mode: it is the same client, the same relay and the same team.

To run it yourself:

```bash
npm run build
npm run export:web     # apps/app/dist
npm run app            # or: npm run web --workspace apps/app
```

Pair it with the relay address and the six-digit code from the MiniMax Bot Bridge
window. Nothing about the browser build is a demo mode: it is the same client, the
same relay and the same team.

A published build names its relay through `EXPO_PUBLIC_RELAY_URL`, which Expo inlines
at build time:

```bash
EXPO_PUBLIC_RELAY_URL=https://minimax-bot-relay.nattiini45.workers.dev \
  npm run export:web --workspace apps/app
```

The field stays editable in the app, so a self-hosted relay is still one tap away.

## Two limits worth knowing

**The relay keeps its state in memory.** The device registry, the bridge token and
the replay ring all live inside the Durable Object, so a restart empties them and
every paired phone has to pair again. That is a deliberate trade — the hibernation
API would let the Durable Object be evicted mid-session and silently drop every
frame — and the client is built for it: the relay accepts the WebSocket and closes
it with a code that says *why*, so the phone asks for a new pairing code instead of
retrying a credential that can never work.

**The team's task tool answers for one batch at a time.** There is no "list every
task" call, so the phone rebuilds the list from the batches the bridge has
dispatched and says that the list is partial rather than pretending it is complete.

## Attribution

By [@nattiini45](https://github.com/nattiini45) (and contributors).
