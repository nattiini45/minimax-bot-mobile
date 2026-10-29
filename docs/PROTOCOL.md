# Protocol

Version `1`. One JSON frame per WebSocket message. The contract lives in
`packages/protocol` and is the only thing the three runtimes share.

## Roles

| Role | Runs in | Talks to |
|---|---|---|
| `app` | Expo client on iOS / Android / PWA | relay |
| `bridge` | MiniMax Code Mini App plugin on the desktop | relay, `@minimax-bot` |
| `relay` | Cloudflare Worker + Durable Object | bridge, app |

The relay never interprets a payload. It authenticates peers, orders events and
forwards. Every decision about the team is made on the desktop.

## Frame envelope

```jsonc
{
  "v": 1,                  // protocol version
  "id": "f_9c1e…",         // unique frame id
  "ts": 1793181000000,     // epoch ms
  "type": "op.send_message",
  "source": "app",         // app | bridge | relay
  "payload": { "chatId": "bot:chief", "text": "hello" },
  "seq": 42,               // optional; assigned by the relay on evt.* frames
  "from": "phone_1",       // optional; assigned by the relay on frames from a phone
  "in_reply_to": "f_9c1e…",// optional; the frame this one answers
  "opId": "op_1753…_a91f"  // optional; idempotency key
}
```

`from` is how the desktop knows which phone sent a frame — it is what makes a
permission decision attributable. The relay sets it, because the relay is the
only thing that knows which socket a frame came from; a peer that carries one has
its frame dropped.

`decodeFrame` enforces exactly the fields the relay relies on: `v`, `id`, `type`,
`source`, `ts`, `payload`, and the types of the optional fields. It deliberately does
**not** deep-validate payloads — a strict validator would reject legitimate
forward-compatible payloads from a newer client. A rejected frame raises `FrameError`
with one of:

`MALFORMED_JSON` · `NOT_AN_OBJECT` · `UNSUPPORTED_VERSION` · `MISSING_ID` ·
`MISSING_TYPE` · `BAD_SOURCE` · `MISSING_TS` · `MISSING_PAYLOAD` · `BAD_SEQ` ·
`BAD_IN_REPLY_TO` · `BAD_OP_ID`

## Frame types

| Prefix | Meaning | Expects a reply |
|---|---|---|
| `op.*` | app → bridge request | yes (`ack` or `err`) |
| `evt.*` | bridge → app notification | no |
| `hello` | app → relay | `hello.ok` |
| `hello.ok` | relay → app | — |
| `ack` | bridge → app | — |
| `err` | bridge → app | — |

`isRequest()` and `isEvent()` are prefix checks; the exhaustive lists are
`OP_TYPES` and `EVENT_TYPES`.

## Operations (app → bridge)

Each operation maps to a team tool, except where noted. The mapping is the
`OP_TOOL` table in `packages/protocol/src/types.ts`, so the client, the relay and
the bridge always agree on which tool backs which operation.

### Reading the team

| Operation | Tool | Payload | Result |
|---|---|---|---|
| `op.list_team` | `list_team` | — | `{ bots, groups, diagnostics }` |
| `op.list_history` | — (bridge local) | `{ chatId, limit? }` | `{ messages }` |
| `op.list_tasks` | `get_tasks` | `{ taskId? \| batchId?, waitMs?, resultOffset? }` | `{ tasks, batchIds?, partial?, note? }` |
| `op.list_helpers` | `list_helpers` | — | `{ helpers }` |
| `op.list_schedules` | `list_schedules` | — | `{ schedules }` |
| `op.get_usage` | — (bridge ledger) | `{ days? }` | `{ buckets, byBot, totals }` |

The team's task tool answers for one batch or one task at a time — there is no "list
everything" call. A client that names one gets that one; a client that names neither
gets every batch the bridge has dispatched, and the answer carries `partial: true`
with a `note` that says so.

### Acting

| Operation | Tool | Payload |
|---|---|---|
| `op.send_message` | *agent-backed* | `{ chatId, text, mentions?, attachments? }` |
| `op.abort_turn` | *agent-backed* | `{ turnId }` |
| `op.dispatch` | `dispatch_tasks` | `{ botIds, prompt, title?, requestId? }` |
| `op.cancel_task` | `cancel_tasks` | `{ taskId \| batchId }` |
| `op.start_helper` | `start_helper` | `{ title?, task, targetBotId? }` |
| `op.stop_helper` | `stop_helper` | `{ helperId }` |
| `op.recall` | `recall` | `{ botId, query, limit? }` |
| `op.remember` | `remember` | `{ botId, text, key?, replaceId? }` |
| `op.forget` | `forget` | `{ botId, id }` |
| `op.create_bot` | `create_bot` | `{ name, role?, instructions?, skin?, color?, model?, main? }` |
| `op.update_bot` | `update_bot` | `{ botId, … }` |
| `op.delete_bot` | `delete_bot` | `{ botId }` |
| `op.create_group` | `create_group` | `{ name, memberIds, admin?, notice?, replyMode? }` |
| `op.update_group` | `update_group` | `{ groupId, … }` |
| `op.delete_group` | `delete_group` | `{ groupId }` |
| `op.create_schedule` | `create_schedule` | `{ name, kind, spec, targetBotId?, prompt? }` |
| `op.delete_schedule` | `delete_schedule` | `{ scheduleId }` |
| `op.react` | — (bridge local) | `{ messageId, emoji }` |

### Agent interaction

`op.send_message`, `op.abort_turn`, `op.respond_permission` and `op.answer_question`
are **agent-backed**: the bridge runs a turn through `context.agent` instead of
calling a team tool. They are listed in `AGENT_BACKED_OPS`.

| Operation | Payload |
|---|---|
| `op.respond_permission` | `{ requestId, decision }` — `decision` is `allowOnce` or `deny`, the only two values the agent API accepts |
| `op.answer_question` | `{ requestId, answers[] }` |

## Events (bridge → app)

| Event | Payload |
|---|---|
| `evt.team_snapshot` | `{ bots, groups, diagnostics, tools }` |
| `evt.turn_started` | `{ chatId, turnId }` |
| `evt.message_chunk` | `{ chatId, turnId, messageId, text, final? }` |
| `evt.message_committed` | `{ message }` |
| `evt.tool_started` | `{ chatId, turnId, toolName, toolInput? }` |
| `evt.tool_finished` | `{ chatId, turnId, toolName, ok, usage?, error? }` |
| `evt.turn_finished` | `{ chatId, turnId, status, reason?, text?, error? }` |
| `evt.permission_requested` | `{ request }` |
| `evt.permission_resolved` | `{ requestId, decision }` |
| `evt.question_requested` | `{ request }` |
| `evt.question_answered` | `{ requestId }` |
| `evt.task_updated` | `{ task }` |
| `evt.helper_updated` | `{ helper }` |
| `evt.schedule_updated` | `{ schedule }` |
| `evt.bridge_status` | `{ desktopOnline, agentAvailable, teamToolsAvailable, linkedAt? }` |
| `evt.reaction_added` | `{ reaction }` |

### Agent event translation

The bridge observes the agent's own event union and maps it one to one:

| Agent event | Protocol event |
|---|---|
| `turn.started` | `evt.turn_started` |
| `text.delta` | `evt.message_chunk` (with `final: true` on the last chunk) |
| `message.committed` | `evt.message_committed` |
| `tool.started` | `evt.tool_started` |
| `tool.finished` | `evt.tool_finished` |
| `permission.requested` | `evt.permission_requested` |
| `question.requested` | `evt.question_requested` |
| `turn.finished` | `evt.turn_finished` |

## Sequencing, resume and idempotency

**Sequencing.** The relay stamps a monotonic `seq` on every `evt.*` frame it forwards
from the bridge, and buffers the tail in a ring (512 entries by default). A client
applies a frame only when `seq > lastApplied`, so a duplicate or an out-of-order
delivery is a no-op.

**Resume.** The device's WebSocket query carries `lastSeq`. On connect the relay
replays everything after that point. If the device fell behind the ring, the reply
sets `truncated: true` and the app resynchronises from a full team snapshot.

**Idempotency.** Operations carry an `opId`. The bridge keeps a ten minute dedupe
cache, so a replay after a reconnect never sends a message twice. The app generates
`opId` as `op_<timestamp>_<random>` and keeps the same id when it retries.

**Ordering.** Only `evt.*` frames are sequenced and buffered. `ack`, `err`, `hello`
and `hello.ok` are conversation-scoped and never replayed.

## HTTP surface

The relay exposes a small REST surface next to the WebSocket. All routes are
prefixed `/r/:accountId`.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/r/:accountId/ws` | GET (upgrade) | `role`, `subject`, `token` in the query | WebSocket for the bridge or a device |
| `/r/:accountId/pair/code` | POST | `Authorization: Bearer <bridge token>` | Issue a pairing code |
| `/r/:accountId/pair` | POST | — | Exchange a pairing code for a device token |
| `/r/:accountId/status` | GET | bridge or device token, or a ticket for one | `{ bridgeOnline, deviceCount, activeDevices, lastSeq }` |
| `/r/:accountId/devices` | GET | bridge token | List paired devices |
| `/r/:accountId/devices/:deviceId` | DELETE | bridge token | Revoke a device |
| `/r/:accountId/devices/me` | DELETE | device token | A device releases its own token |
| `/r/:accountId/ws-ticket` | POST | bridge or device token | A ticket for the next connection |

The WebSocket authenticates through the query string because the browser WebSocket
API cannot set headers. The `role` is `bridge` or `device`; the `subject` is the
bridge id or the device id.

What is in the query string is a **ticket**, not the peer's credential. A peer
first asks the relay for one over an ordinary request - which can carry a
header - and the ticket is what travels in the URL. A ticket is good for one
connection and for half a minute, and the room refuses the second attempt with
the same one. A URL that is kept somewhere - a log, a proxy - is therefore worth
nothing a minute later. The long-lived token is still accepted in the query
string, for a client that cannot ask for a ticket.

A bridge token also has to be bound to the account: the token carries the account
it was minted for, and the relay refuses it against any other one. The account in
the path and the account in the token have to be the same. Device tokens carry no
account — the relay scopes a device by the device registry of the account's own
room. See `PAIRING.md` for the token payload.

## Bridge loopback surface

The bridge's own HTTP server is loopback-only and exists for the desktop surface.
It is not reachable from a phone.

| Route | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Liveness |
| `/api/status` | GET | Bridge id, relay state, diagnostics, pending count |
| `/api/pair/code` | POST | Ask the relay for a pairing code |
| `/api/devices` | GET | Paired devices |
| `/api/devices/:deviceId` | DELETE | Revoke a device |
| `/api/snapshot` | GET | Full team snapshot plus the tool catalogue |
| `/api/config` | POST | Update relay URL, account id and bridge name |

## Error handling

A failed operation answers with an `err` frame:

```jsonc
{ "type": "err", "in_reply_to": "f_9c1e…", "opId": "op_1753…",
  "payload": { "code": "INVALID_ARGUMENTS", "message": "…", "retryable": false } }
```

`retryable` tells the app whether the same op may be re-sent. `INVALID_ARGUMENTS`
additionally carries the tool's live `inputSchema` and the list of missing
properties, so the client can ask for the exact field rather than guess.

Relay-level codes are listed in `RelayErrorCode` and described in
`describeRelayError`: `UNAUTHORIZED`, `PAIRING_CODE_INVALID`, `PAIRING_CODE_EXPIRED`,
`PAIRING_CODE_UNKNOWN`, `DEVICE_REVOKED`, `BRIDGE_OFFLINE`, `BAD_REQUEST`,
`RATE_LIMITED`.

## Schema-driven tool arguments

The `@minimax-bot` MCP server's parameter names are not readable from outside a Mini
App, so the bridge never hardcodes them. It reads each tool's `inputSchema` from the
live catalogue and maps the operation payload onto it with an alias table
(`botId` → `to` / `bot_id` / `target`, `text` → `message` / `content`, …). When a
required property cannot be satisfied, the bridge refuses with `INVALID_ARGUMENTS`
and returns the schema plus the missing properties.

`packages/bridge/miniapp/node/tools.mjs` holds the alias table and the mapper;
`packages/bridge/test/tools.test.mjs` covers it.
