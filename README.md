# minimax-bot-mobile

A mobile companion for your **MiniMax Bot team in MiniMax Code**. Browse your team, talk to Bots and groups, follow tool activity, and manage desktop work from Android or a browser.

This is an independent project, not an official MiniMax application. Your desktop must be running. The relay is a connection service, not an agent hosted in the cloud.

## What it does

- **Team conversations:** send messages to a Bot or group and read the desktop's conversation history and completed tool activity.
- **Hosted conversations:** run a separate, bridge-owned session on your desktop, with streaming replies and phone-accessible permissions and questionnaires.
- **Your actual team:** load profiles, group membership and artwork from the desktop at runtime rather than bundling a replica.
- **Desktop controls:** inspect known tasks and helpers, edit Bot settings and memory, manage schedules, and browse installed capabilities.
- **Connection management:** pair using a single-use code and revoke paired devices from the desktop bridge.

Android and web are the primary targets. The shared Expo code also targets iOS; a native iOS release requires validation on Apple hardware.

## How it connects

The Expo client connects to a Cloudflare Worker relay. A Mini App bridge on your desktop makes an outbound connection to the same relay and calls MiniMax Code's granted agent and team-tool capabilities. No inbound desktop port needs to be exposed to the internet.

There are two distinct conversation modes:

| Mode | Conversation | Activity |
|---|---|---|
| In the team | The Bot or group's existing desktop conversation | Working status, followed by the desktop's completed reply and recorded tools |
| On this desktop | A separate bridge-owned session for that Bot | Streaming output and interactive hosted approvals/questions |

Hosted exchanges do not become part of the official Bot application's transcript. Groups always use the team's own routing.

## Requirements

- Node.js 24 LTS, version 24.15.0 or newer, and **npm 12.2.1** (`npm@12.2.1`). The manifest also permits supported Node 22 and 26+ releases; use Node 24 for the simplest setup.
- MiniMax Code Desktop with the official MiniMax Bot plugin running.
- A Cloudflare account for your own relay, or a relay operated by someone you trust.
- For Android release builds: Linux or WSL2, JDK 17, the Android SDK, and your own release signing key.

You do not need to put a MiniMax API key in the mobile app or relay. The desktop uses its existing account and granted capabilities.

## Local development

First select a supported Node version with your Node manager. If npm is not already **12.2.1**, bootstrap it **outside the checkout** so the repository's version gate does not reject the older npm before it can update:

```sh
# Run from outside the repository, for example its parent directory.
npm install --global npm@12.2.1
npm --version
# Expected: 12.2.1
```

This uses your Node installation's npm prefix. Prefer a user-managed Node installation rather than running project builds as an administrator or root. Return to the repository root, then run:

```sh
npm ci
npm run build
npm run typecheck
npm test
```

Start the client with one of:

```sh
npm run web -w @minimax-bot/app
npm run android -w @minimax-bot/app
npm run ios -w @minimax-bot/app
```

The iOS development command requires macOS and Xcode. Android development requires a configured device or emulator. The app is a live remote control; it does not include a simulated desktop or bundled conversation data.

### Set up the relay

In `packages/relay`, configure a strong `RELAY_SECRET` through Wrangler's secret management and deploy the Worker:

```sh
cd packages/relay
npx wrangler secret put RELAY_SECRET
npx wrangler deploy
```

These are operator-run deployment commands; local builds and tests do not deploy the relay. Keep the relay secret out of Git, command-line arguments and mobile bundles.

Mint a credential for your desktop from the repository root:

```sh
npm run mint:token -- --bridge-id bridge_example --bridge-name MyDesktop --account default --hours 24 --secret-file ../private/relay-secret.txt
```

The private file must contain the same secret configured on your Worker and must be outside this repository. Keep the bridge ID stable when replacing its credential. The minting command prints a credential: do not paste that output into issues, screenshots or logs.

### Install and pair the bridge

1. Run `npm run build` so the bridge includes its generated protocol artifact.
2. Install `packages/bridge` as a local MiniMax Code plugin and open its Mini App surface.
3. Configure your relay's HTTPS URL, account ID, desktop credential and the same bridge ID used when minting it (`bridge_example` above).
4. Request a pairing code on the desktop and enter it, along with the same relay and account, on the phone.

See [Pairing and credentials](docs/PAIRING.md) for the wire flow, credential lifetimes, revocation and troubleshooting.

### Optional default relay

Set `EXPO_PUBLIC_RELAY_URL` in the build environment to prefill your relay address. This value is public and becomes part of the client bundle. It is not a place for tokens or secrets. Without it, users enter their own relay address during pairing.

```sh
npm run export:web
```

The static web output is written to `apps/app/dist`. Serve it using HTTPS. Exporting does not upload or publish anything.

## Android release builds

Use the guarded Linux build script, not a generated Gradle project's debug signing configuration. Supply these values through a private environment or CI secret store:

- `EXPO_ANDROID_KEYSTORE_PATH`
- `EXPO_ANDROID_KEYSTORE_PASSWORD`
- `EXPO_ANDROID_KEY_ALIAS`
- `EXPO_ANDROID_KEY_PASSWORD`
- `EXPECTED_RELEASE_CERT_SHA256`
- `EXPO_PUBLIC_RELAY_URL`

Pass explicit source and writable build paths:

```sh
bash scripts/build-android.sh "$PWD" "$PWD/artifacts/android-build"
```

The script prints the signed artifact's location and checks its certificate and embedded relay address. Keep the keystore outside the source and build trees. Retain the same signing identity for updates; a different certificate cannot replace an installed application without a valid signing lineage. Do not uninstall a working app simply to bypass a signing mismatch.

Release Android builds forbid cleartext connections. Development builds allow loopback for a local relay, which can be reached using `adb reverse tcp:8787 tcp:8787`.

## Security and privacy boundaries

- **Trust your relay operator.** TLS protects each connection, but the JSON forwarded by the relay is not end-to-end encrypted. The relay can read conversations and operation payloads.
- **Treat pairing as desktop access.** A paired device can exercise the bridge's available functionality. Share pairing codes only with intended users and revoke devices you no longer control.
- **Keep credentials private.** Relay signing secrets, bridge credentials, device tokens and signing keys must never enter source control or public reports.
- **The desktop is a trust boundary.** Loopback and browser-origin checks defend the local web surface; they do not sandbox other native processes on the same machine.
- **Reconnect is bounded, not archival storage.** Relay replay, pending requests and in-memory client history have limits. Hosted history is process-local; the desktop remains the source of truth for team conversations.
- **Capabilities are granted, not reproduced.** The bridge does not modify the official MiniMax Bot plugin, and features depend on the Host and team-tool contracts available on that desktop.

For security-sensitive configuration and current storage behavior, read [Pairing](docs/PAIRING.md) alongside the source. Tests and successful builds are not a guarantee that every device, Host version or deployment is secure.

## Project layout

| Path | Purpose |
|---|---|
| `apps/app` | Expo / React Native client and web target |
| `packages/protocol` | Shared frame and operation contract |
| `packages/relay` | Cloudflare Worker, Durable Object and relay session |
| `packages/bridge` | Desktop Mini App bridge and pairing surface |
| `docs/ARCHITECTURE.md` | Components, trust boundaries and runtime data flow |
| `docs/PROTOCOL.md` | Wire contract and delivery semantics |
| `docs/PAIRING.md` | Operator setup and credentials |

The protocol is a workspace dependency for the relay and client. `packages/bridge/scripts/sync-protocol.mjs` vendors its compiled output into the bridge package during the build; generated files are not checked in.

## Checks

```sh
npm run typecheck
npm run test:policy
npm run test:bridge
npm run test:unit
npm run test:app
npm run export:web
```

Test totals change with the source; use the runner output rather than a hard-coded count. Native compilation, signing, installation and device behavior need their own checks in addition to unit tests.

## License

Project code is available under the [MIT License](LICENSE): use, modify and redistribute it, including commercially, while preserving the required notices. Third-party code and artwork retain their own terms; see [Third-party notices](THIRD_PARTY_NOTICES.md).

MiniMax names and marks identify the products this project connects to. The project license does not grant trademark rights or imply MiniMax's endorsement.
