# Creation note — MiniMax Bot in your pocket

**What I built:** a native mobile client for the `@minimax-bot` team, running inside MiniMax Code.
One codebase, three surfaces — Android, iOS and an installable PWA — plus the two pieces a
phone cannot have on its own: a Mini App plugin that drives the real team, and a Cloudflare
Worker that carries frames between the desktop and the phone.

**How I used M3.1 Flash:** it did the engineering, not just the typing. The interesting part of
this project is not that a model wrote a chat UI; it is that the model worked against a live
system, disagreed with the obvious reading of it, and found the bugs nobody would have told it
about.

## It read the real system instead of guessing

The team's tools speak snake case (`bot_id`, `group_id`, `reply_mode`) and answer with nested
tool shapes that no schema hints at. M3.1 Flash went to the official plugin's own source,
copied the wire shapes verbatim, and wrote the bridge against those shapes. It also caught the
difference between the team's *memory* pagination (1–20) and the team's *task* pagination,
which are not the same limit.

The discipline it applied to itself: **a mock must copy the real system, never the protocol you
wish it had.** An earlier mock in this repo spoke camel case and `memberIds`; against the real
team every chat route became `/bot/undefined`. The mock made the whole suite green while
hiding exactly the bug it was written to catch.

## It found bugs by testing against reality

Every one of these was found by running the real stack, not by reading code:

| What broke | How it showed up |
|---|---|
| The Durable Object was not RPC-capable | every relay call answered *"The receiving Durable Object does not support RPC"* |
| Sockets accepted with `server.accept()` delivered no frames | the phone connected and heard nothing |
| A refused peer was answered with HTTP 401 | the phone retried forever, so it could never learn it had been unpaired |
| The release APK bundled a **stale** workspace package | the app crashed on launch with `Cannot read property 'unauthorized' of undefined` — the build host had only `apps/app`, so the protocol package never arrived |
| The relay replayed `ack`/`err` frames to new devices | a resuming phone was handed the answers to requests it never made |
| The chat history dropped the team's replies | reopening a chat showed an empty thread — only your own messages survived |

The fourth one is the one I am proudest of: it is a *pipeline* bug, not a code bug. The code was
correct; the build simply never received the change. M3.1 Flash traced it from a runtime crash
to a missing directory in a copy step, then fixed it in three places (whole-workspace sync, an
always-on `expo prebuild`, and a Gradle input declaration so the bundle task tracks the
workspace package).

## It kept the promise honest

The project ships with **181 passing tests** (protocol, relay, bridge, client), and the
end-to-end run is against a live six-bot team: a real pairing code, a real streamed reply, a
real dispatched task, real memory entries read back out of the team's own store.

The app shows the work, not only the answer. The bridge reports every tool the team runs, and
the phone renders it live — `tool_search · 15ms`, `mcp_invoke · 20ms` — so a reply is a visible
process instead of a long silence. That trace only exists because the protocol already carried
those events and the client was throwing them away; M3.1 Flash noticed the waste while
recording a demo session, and wired it up.

## Then something reviewed it that had not written it

The code above was **verified against the live system**, and that is exactly why it needed a
review: everything it did wrong was in the code it had already "verified". So three
independent reviewers read it with fresh eyes and no history of how it was written.

They found **six defects that would have shipped**, and two tests that would have passed
against the very code they were written to catch.

The sharpest finding was a test that could not fail. The relay had a bug: a control frame
that arrived *after* an event was replayed to a device that never sent the request, so a
stale `err` looked like a failure that had just happened. The regression test sent its
frames in the wrong order — the control frames first — and a control frame that arrives
first lands in the ring at sequence 0, which a resuming device filters out anyway. **The
pre-fix code passed the test.** The order was changed, and the difference is now explicit:

```
OLD (pre-fix)  ringSeqs=[1,1,1]  replayTypes=[evt.team_snapshot,ack,err]  entries=3
NEW (fixed)    ringSeqs=[1]      replayTypes=[evt.team_snapshot]            entries=1
```

The other findings were the kind that only a careful reader finds:

- The host reports a tool call **without its input** — it sends four fields and rejects a
  fifth — so the field the trace carried could never exist, and the test that asserted it
  was certifying a contract that could not hold.
- The host emits one event per tool call and does not name two calls of the same tool
  apart, so measuring them by name measured the wrong call. A real turn in this project
  runs `bash` four times; every one of them now carries its own id and its own duration.
- A turn that finished late cleared the *new* turn, so the phone stopped showing the work
  in progress.
- A tool that never reported back stayed "running" for ever, and the phone kept claiming
  the team was working.

Two of the reviewers were asked to prove their findings by running the code rather than
reasoning about it: one rebuilt the pre-fix relay in a sandbox to show the test could not
fail, and the other transpiled the real store and drove it through eight frame orderings.
Both found things I had read past.

**181 tests pass**, and the new ones were written to fail against broken code: the duration
has to be a real measurement, the call ids have to be distinct, the history has to be in
order.

## It is running on the public internet

The relay is a deployed Cloudflare Worker, not a script on my laptop:

- **Live client:** <https://n5qi7wnkhcwnd.space.minimax.io>
- **Relay:** <https://minimax-bot-relay.nattiini45.workers.dev>
- **Demo video:** <https://github.com/nattiini45/minimax-bot-mobile/releases/download/v0.1.0/demo.mp4>

A published build names its relay through `EXPO_PUBLIC_RELAY_URL`, which Expo inlines at build
time, so the link above opens a client that already knows where to go — a stranger types the
six-digit code and drives the real team. The last end-to-end run over the public path paired a
device over HTTPS, opened the WebSocket over TLS, pulled the real six-bot roster and recorded
**twelve tool calls with twelve distinct call ids, every start matched to its own finish, and
no error frames in the replay**.

## Honest limits

- The relay keeps its state in memory, so a restart unpairs every phone. Both ends handle it.
- The team's task tool answers for one batch at a time, so a task list is explicitly partial —
  the phone says so instead of looking complete.
- The `v0.1.0` APK was signed with the Expo template's debug keystore. That keystore
  is a well-known value, so anyone can produce an APK with the same signing identity
  and the operating system would take it as an update to an installed one. The asset
  has been withdrawn.
- A release is signed with a private key now. The build refuses to run without it,
  and it checks the certificate of the artefact it produced before the build is
  allowed to pass. The native build needs Linux (RN 0.88 hits the 260-character path
  limit on Windows).

---

Built with **M3.1 Flash** in **MiniMax Code**. #MiniMaxCode
