# Submission copy

Every post below satisfies the brief: it names **MiniMax Code** and **M3.1 Flash**, links a
public artifact, carries the creation note, and uses `#MiniMaxCode`.

> **Fill these in before posting:** `{{LIVE_APP}}` (the public PWA link), `{{REPO}}` (the public
> repository), `{{VIDEO}}` (the demo video), `{{SCREENSHOTS}}` (the image links).
>
> **Keep every post public** until the winners are announced. Do not delete, edit to hide, or
> post to a private channel only.

---

## 1. Discord — `🧩丨show-your-case`

This is the entry point. Post it in the channel, and post it *before* Nov 3.

```
Built a native mobile app for the @minimax-bot team — one codebase for Android, iOS and PWA —
with MiniMax Code and M3.1 Flash. #MiniMaxCode

Live app (open it, it is the real client): {{LIVE_APP}}
Source: {{REPO}}
Demo video: {{VIDEO}}

What it is: a Mini App plugin drives the real six-bot team (Chief, Engineer, Reviewer,
Researcher, Writer, Game Dev) over the real team tools, a Cloudflare Worker carries the frames,
and an Expo/React Native client renders the chat, the live tool trace, the task board and the
team's memory — on Android, iOS and as a PWA.

How I used M3.1 Flash: it did the engineering. It read the official @minimax-bot plugin's source
to copy the real wire shapes instead of guessing them, then worked against a live system until
it found six real bugs — including a build-pipeline trap where the release APK silently shipped
a stale workspace package and the app crashed on launch. It also found that the client was
discarding the tool-call events the bridge already sent, and wired them up so a reply shows
its work: "tool_search · 15ms", "mcp_invoke · 20ms".

Creation note: {{REPO}}/blob/main/docs/CREATION-NOTE.md
```

---

## 2. Reddit

Post to a technical community (r/programming, r/reactnative, r/SideProject, r/LocalLLaMA —
check each subreddit's self-promotion rule first). Keep the title honest and specific; a
technical write-up does better than a launch announcement.

**Title**

```
I built a native mobile client for the @minimax-bot team with MiniMax Code (Expo + Cloudflare
Worker + a Mini App plugin)
```

**Body**

```
MiniMax Code can run a team of agents on your desktop. What it could not do was let you talk
to that team from your phone.

So I built one: https://github.com/nattiini45/minimax-bot-mobile
Live app (the real client, in a browser): {{LIVE_APP}}
Demo video: {{VIDEO}}

Four packages:

- packages/protocol — the frame contract shared by the phone, the relay and the bridge
- packages/relay — a Cloudflare Worker + Durable Object that routes frames and nothing else
- packages/bridge — a Mini App plugin that drives the real @minimax-bot tools
- apps/app — an Expo/React Native client (Android, iOS, PWA) built with expo-router

Pairing is a six-digit code from the desktop; the phone then sees the live roster, can chat
with any bot (the reply streams token by token), can dispatch work to the team, and can read
and write the team's memory. It also shows the work: the bridge reports every tool the team
runs, so the client renders a live trace — "tool_search · 15ms", "mcp_invoke · 20ms" — instead
of a long silence.

The interesting part was the debugging, and I want to be specific about it because it is the
part I would not have predicted:

- The Durable Object type-checked fine but failed every RPC call at runtime, because it did
  not extend the base class.
- Sockets accepted with server.accept() never delivered inbound frames; the message handler
  has to be registered with addEventListener.
- A refused peer was answered with HTTP 401, so the phone could never learn it had been
  unpaired and retried forever. The fix was to accept the upgrade and close the socket with a
  reason code.
- The worst one was a build bug, not a code bug: the release APK shipped a STALE workspace
  package, so the app crashed on launch with "Cannot read property 'unauthorized' of
  undefined". The code was correct; the build host had only received apps/app, so the
  protocol package never arrived. It needed a whole-workspace sync, an always-on expo
  prebuild, and a Gradle input declaration so the bundle task tracks the workspace.

All of it was built with M3.1 Flash in MiniMax Code. The full story, including the limits I
did not fix, is here: {{REPO}}/blob/main/docs/CREATION-NOTE.md

168 tests pass across the four packages, and the end-to-end run is against a live team — real
pairing code, real streamed reply, real dispatched task, real memory entries.

Questions welcome. Especially about the relay design and the build pipeline.
```

---

## 3. X / Twitter

Post as a thread. Attach the screenshots, link the live app in the first post.

```
I built a native app for the @minimax-bot team — Android, iOS and PWA from one codebase —
with M3.1 Flash in MiniMax Code. #MiniMaxCode

The model did the engineering, not just the typing. It worked against a live six-bot team and
found six real bugs, including a build-pipeline trap that shipped a stale package and crashed
the app on launch.

It also found that my client was throwing away the tool-call events the bridge already sent.
Wiring them up turns a reply from a long silence into a live trace:

  tool_search · 15ms
  mcp_invoke · 20ms

Live app: {{LIVE_APP}}
Source: {{REPO}}
Demo video: {{VIDEO}}
```

---

## Checklist before the deadline

- [ ] The live link opens from a logged-out browser (test it in a private window).
- [ ] The demo video shows the real app: pairing, a streamed reply, the live trace.
- [ ] Both posts name **MiniMax Code** and **M3.1 Flash**, and carry `#MiniMaxCode`.
- [ ] The Discord entry is posted in `🧩丨show-your-case` with the public link + creation note.
- [ ] No token, pairing code, local path or personal data appears in any screenshot or clip.
- [ ] Every post is still public, and will stay public until the winners are announced.
