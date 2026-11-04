# Architecture

Three components and one shared contract, across four packages.

```text
┌──────────────────────────┐
│  PHONE / WEB             │  apps/app — Expo / React Native
│  Expo app                │  iOS · Android · web
└───────────┬──────────────┘
            │  WSS, device credential via ticket (token fallback)
            ▼
┌──────────────────────────┐
│  RELAY                   │  packages/relay — Cloudflare Worker + Durable Object
│  Worker + DO             │  pairing · fan-out · bounded replay · presence
└───────────┬──────────────┘
            │  WSS, bridge credential via ticket (token fallback)
            ▼
┌──────────────────────────┐
│  BRIDGE                  │  packages/bridge — MiniMax Code Mini App plugin
│  minimax-bot-bridge      │  team turns · team tools · approvals · usage ledger
└───────────┬──────────────┘
            │  Mini App capabilities
            ▼
┌──────────────────────────┐
│  MiniMax Code Host       │  context.agent + context.tool
│  @minimax-bot tools      │  official plugin; not modified by this project
└──────────────────────────┘
```

`packages/protocol` defines frames, operations, events and pairing vocabulary.
The relay and app import it as a workspace package; a synced copy is included in
the bridge artifact.

## Why the bridge is a Mini App

The [manifest](../packages/bridge/miniapp/miniapp.json) requests
`agentAccess: ["session.run"]` and `toolAccess: ["call"]`. The bridge uses the
Host-provided `context.tool` API to reach the `@minimax-bot` team, and
`context.agent` for the Host's own questions about a run it owns. It does not run a
second agent service. It listens on the Host-assigned loopback address and opens an
outbound WebSocket to the relay; the phone does not dial the desktop directly.

The bridge's HTTP surface uses Host-header, browser-origin and per-process-secret
checks. These do not isolate it from other native processes on the same desktop.
See [Pairing](PAIRING.md#loopback-access-and-automation).

## What the bridge does

1. **Links the team.** It reads `context.tool.list()`, keeps the MiniMax Bot tools
   and publishes the catalogue and roster to the app.
2. **Runs Bot turns.** It hands a turn to the `@minimax-bot` team itself — `message_bot`
   for a Bot's own chat, `post_group` for a group — and asks `get_tasks` until the task
   settles, so the reply is the Bot's own text, in the Bot's own session and
   conversation. The Host's general assistant is not in this path: it has no Bot to
   become. A Bot's own chat can instead run on the desktop, under the bridge, so that
   a permission check or a questionnaire the Bot raises can be answered from the phone.
3. **Calls team tools.** It maps operation payloads onto each live `inputSchema`
   before calling `context.tool.call()`.
4. **Holds approvals.** Pending permissions and questions stay in bridge memory
   with a ten-minute TTL and are re-emitted on resume.
5. **Records activity.** `ledger.json` stores bounded usage/execution records,
   permission decisions, access changes and dispatched batch ids. It is not a
   conversation transcript or a copy of the desktop product's usage database.

### Chat routing

The chat id says who a turn is for: `bot:<botId>` is that Bot's own conversation and
`group:<groupId>` is the group. The bridge reads the prefix and calls the matching
team tool, so the Bot that answers is the Bot the phone picked, with that Bot's own
instructions, model, effort and session. Mentions are translated from Bot ids to the
`@Name` the team reads.

A Bot's turn can also run on the desktop under the bridge, in a separate
bridge-owned session per Bot. Later hosted turns reuse that session during the
same bridge process; they do not continue the desktop Bot's session. The Host only
lets the Mini App that owns a run answer its questions, so hosted permissions and
questionnaires can be answered from the phone. The Bot keeps its name, role,
instructions, model and effort, but hosted exchanges are not written into the
desktop Bot app's transcript. A group is always the team's, because who speaks
first and who hands over to whom are the product's rules.

The user chooses per Bot, and the choice is remembered: `op.set_bot_mode` writes it
into the bridge's configuration, and the roster carries it back to the phone as
`Bot.runMode`. A turn runs in the team unless the phone says otherwise, so that the
desktop's own conversation is the record of what was said.

The phone's thread is read from the desktop's own transcript, read-only, for a turn the
team ran — the same messages with the same ids the desktop shows. A turn the bridge
runs itself is not in that transcript, so the bridge keeps it, and the phone is shown
both.

Sources: [router](../packages/bridge/miniapp/node/bot-router.mjs),
[model picker](../packages/bridge/miniapp/node/bot-model.mjs),
[agent runner](../packages/bridge/miniapp/node/agent.mjs),
[bridge dispatch](../packages/bridge/miniapp/node/bridge.mjs).

## Where the desktop's own team lives

The bridge combines the tool roster with read-only access to the desktop Bot app's
state and artwork. Paths are resolved from the bridge's `context.dataDir`:

| Data | Path |
|---|---|
| Bot profiles and group metadata | `../minimax-bot/state.json` |
| Uploaded Bot pictures | `../minimax-bot/avatars/<name>` |
| Skin artwork | `<runtime>/plugin-cache/official/*/miniapp/client/skins/<look>.png` |

For artwork, it selects the most recently modified matching cache directory whose
Mini App manifest identifies the Bot plugin. Missing or unreadable files leave the
tool roster intact and let the phone draw a fallback avatar. Artwork is fetched
over the link at runtime, not bundled into the phone app.

These lookups live in
[`desktop-team.mjs`](../packages/bridge/miniapp/node/desktop-team.mjs). They depend
on the desktop runtime's directory layout.

## What the desktop can do, on the phone

Two things the phone shows are the desktop's own, read at runtime and never copied into
the app:

| Thing | Where it comes from | How the phone uses it |
|---|---|---|
| The models that can run | the Host's catalog (`agent.models()`) | a list to pick a Bot's model and effort from, so the phone cannot offer a model the Host does not have or an effort the model does not have |
| The skills, plugins and agents | the Host's installation | the toolbox: a list of what the desktop can do, from which a skill is put into a conversation's composer as `/name` — for the user to send, or not |
| The MCP servers | the Host's `mcp.json` | the toolbox as well: a Bot's turn can call their tools, so they are part of what the desktop can do |

The bridge reads them and never runs them: a skill is a thing the desktop can do, and
what to ask of it is the user's call. The paths are resolved from the bridge's
`context.dataDir` — the Host's home is four levels up from the bridge's own data
directory — and a folder the Host does not have is simply not listed. Junctions count as
folders, because the Host keeps most of the user's skills as junctions.

The readers live in
[`capabilities.mjs`](../packages/bridge/miniapp/node/capabilities.mjs) and
[`bot-model.mjs`](../packages/bridge/miniapp/node/bot-model.mjs).

## What the phone knows while a turn is running

A turn the team runs belongs to the desktop: the Bot's answer is written into the
desktop's own transcript, and the team holds the run. Two things follow, and the phone
says both rather than staying silent:

- **The work is shown.** The desktop says `Chief is working on "Note-check" — you can
  keep chatting` while its Bot works. The phone says the same, and says how long the
  work has been going on: a turn the team runs can take many minutes, so the phone
  breathes while it waits instead of sitting still. The phone knows the turn is running
  from `evt.turn_started`, which carries when it began, and what it is about from the
  last message in the thread.
- **The whole exchange arrives when the turn ends.** The team reports a task's text
  only once the task settles, and the desktop writes a turn's record — every narration,
  every tool call, the answer — when the turn ends too. The bridge reads that record
  back and publishes it, so the phone ends up with the same bubbles the desktop shows:
  the same words, in the same order. The live narration the desktop streams meanwhile is
  the plugin's own event stream, and that one is not readable through any surface the
  bridge holds.

Both surfaces read the same record, so a thread that is read back is the thread that
was shown: the messages carry the ids the live events carried, and the tool calls travel
with them, so a phone that opens the conversation later sees the same work.

### How many calls a conversation keeps

A turn can use many tools, and a chat can contain many turns. The bridge and phone
apply the same retention policy so a history refresh does not silently discard part
of the activity the bridge sent.

The shared policy has a **400-call soft target**, not a hard per-turn cap
([`activity.ts`](../packages/protocol/src/activity.ts)). History responses retain
up to 200 messages; hosted message/activity storage targets 50 chats, preserving
active chats until they settle. Team history is
reread from the desktop after a bridge restart, whereas hosted messages,
bridge-only notes and reactions are process-local.

The retention rule is:

- A turn is kept **whole**. A turn that showed only some of its calls would say that the
  Bot used fewer tools than it did.
- Whole turns go, and the **oldest** go first.
- The **newest** turn is never dropped. A turn that is larger than the limit on its own
  is kept whole rather than under-reported.
- A turn that is still **running** stays: it is the truth about what the team is doing.

The target applies to a conversation's retained calls, not to the number of tools
a single turn may use.

When the team stops for a reason the phone must know about — the Bot asked a question
the user has to answer — the bridge writes a note about it into the conversation and keeps
it there. The desktop's transcript does not hold that note, so a bridge that did not keep
it would lose it as soon as the phone re-read the thread, and the phone would be left
with a Bot that asked a question and no hint of where the answer goes.

## What the desktop shows that the phone does not

The desktop marks a message that arrived from somewhere else — the phone's own message
arrives as a note that it came from the user's MiniMax Code chat. The phone marks the
other way round: a message the user typed on the desktop is shown as `From your
desktop`, because from the phone it would otherwise be indistinguishable from one the
phone sent.

A turn the bridge runs itself never reaches the desktop's transcript, so the desktop
shows nothing of it. That is why a hosted Bot says so where its mode is chosen: the
exchange stays on the phone, and the desktop Bot app does not keep it.

## How a group is drawn

A group has no picture of its own on the desktop: it is drawn as a pile of its members.
The desktop's own tables decide the pile — up to three members, the admin in front, and
each member's place given as a fraction of the mark — and the phone copies those tables
from `miniapp/client/octopus.js` (`groupMark`) rather than inventing its own, so the
same group looks the same on both screens.

Two details make the pile read as the desktop's. The members are drawn whole rather
than cropped into discs, because the desktop draws a Bot's artwork uncropped
(`object-fit: contain`), and the pieces are separated by a halo in the colour of the
ground they lie on, which is the desktop's `drop-shadow` ring. The pictures themselves
are still fetched at runtime: the app bundles no Bot artwork.

The launcher icon is the only artwork that ships in the app — an icon cannot be fetched
at runtime. It is the same pile, drawn from MiniMax's own artwork by
[`scripts/make-app-icon.mjs`](../scripts/make-app-icon.mjs), and it carries MiniMax's
MIT notice (`apps/app/assets/LICENSE-MINIMAX.txt`).

## Schema-driven arguments

The bridge reads each tool's live `inputSchema` and maps operation fields using an
alias table (`botId` → `to` / `bot_id` / `target`, `text` → `message` / `content`, …).
This avoids assuming one fixed parameter spelling.

Mapping or validation failures return `INVALID_ARGUMENTS` with schema-derived
field-name details (`missing`, `required`, `unmapped`, `properties`, as applicable),
not the full schema. See [tool gateway](../packages/bridge/miniapp/node/tools.mjs)
and [its tests](../packages/bridge/test/tools.test.mjs).

## Relay design

One Durable Object serves each account. Its
[`RelaySession`](../packages/relay/src/session.ts) owns pairing, peer registration,
sequence state and event replay; the Durable Object provides transport and storage.

- **Pairing:** a single-use six-digit code lasts five minutes by default, with a
  requested lifetime clamped to one–fifteen minutes.
- **Authentication:** peers normally exchange a bearer token for a 30-second,
  single-use connection ticket. Both clients retain a token-in-URL fallback.
- **Fan-out:** bridge `evt.*` frames receive a monotonic `seq` and enter a bounded
  in-memory replay ring (512 entries / 4 MiB by default). Incoming frames over
  512 KiB are dropped before JSON parsing; status reports a dropped-frame count.
- **Resume:** a device supplies `lastSeq`. The relay replays available events and
  reports `truncated` when it cannot serve the requested range.
- **Deduplication:** the bridge, not the relay, keeps process-local operation results
  for up to ten minutes, capped at 500 entries shared across peers and operations.
  Eviction or restart can allow an operation to run again; this is best effort,
  not durable exactly-once execution.
- **Trust:** the relay can read the JSON and holds plaintext replay events in memory.
  There is no application-level end-to-end encryption. It does not execute tools;
  execution stays on the desktop.

The relay persists its device registry (metadata, token hashes, expiry and revocation),
pairing codes, account owner, sequence counter and bridge-token revocation cutoff.
Sockets and replay events are not durable. Bridge tokens default to 24 hours;
automatic rotation is checked only at bridge startup, not continuously. See
[Pairing](PAIRING.md#bridge-token-renewal) for operator responsibilities.

## State and ownership

| Concern | Owner | Current behavior |
|---|---|---|
| Chat history | Desktop transcript + bridge memory | Team history is reread from desktop; hosted messages and bridge-only notes are process-local. |
| Reactions | Bridge memory | Bounded buckets, lost on bridge restart. |
| Host sessions | Team or bridge + Host | Team sessions remain desktop-owned; hosted turns use separate bridge-owned per-Bot sessions with the selected Bot configuration. |
| Turn execution | Team or Host through bridge | Independent of the phone connection while the bridge/Host remain running. |
| Usage, decisions and known batches | Bridge ledger | Persisted separately from chat text, partitioned by relay/account/bridge identity. |
| Frame ordering and replay | Relay | Sequenced events; bounded plaintext memory buffer. |
| Operation deduplication | Bridge | Up to ten minutes / 500 process-local entries; no exactly-once guarantee. |
| Concurrency | Bridge runner | Up to 32 active Host calls. Hosted work has bounded admission and serializes each chat through result/session installation; other chats remain parallel. Excess work fails with retryable `BUSY`. |
| Pending approvals | Bridge memory | Ten-minute TTL; re-emitted on resume, not restored after bridge restart. |
| Offline composition | App | Outbox queues messages for reconnect. |
| Reconnect | App + relay | Backoff 1/2/4/8/16/30 s with jitter; `lastSeq` resume. |

Bridge-owned state lives under `rooms/<identity-hash>/ledger.json` and is not reused
when the relay, account or bridge identity changes. A legacy unscoped ledger is
retained rather than silently assigned to a new room. This partitioning does not
remove Desktop team history or explicit task operations that the paired Host
already authorizes.

`op.list_history` merges read-only desktop team records with bridge-owned messages.
The desktop-backed portion survives a bridge restart; hosted messages, bridge-only
notes and reactions do not. The ledger cannot restore those process-local exchanges.
A history response retains the latest 200 messages; bridge-owned message/activity
storage targets 50 chats while preserving active work. Reaction buckets cover up
to 500 message ids.

## Package layout

```text
packages/
  protocol/    frames, operations, events, pairing vocabulary
  relay/       Worker, Durable Object and framework-agnostic RelaySession
  bridge/      Mini App node artifact and desktop surface
apps/
  app/         Expo client
docs/          documentation
```

## Verification

From the repository root:

- `npm run test:unit` — protocol, relay and build-script tests (Vitest).
- `npm run test:bridge` — bridge tests (node:test).
- `npm run test:app` — app tests (Jest + jest-expo).
- `npm run typecheck` — workspace type checks.
- `npm run export:web` — app web bundle.

Automation can exercise the local configuration and live relay/bridge flow when
MiniMax Code is running. These commands alone do not verify a live Host handshake,
Host hardening, or selected-Bot execution semantics.
