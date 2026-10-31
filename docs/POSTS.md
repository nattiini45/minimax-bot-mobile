# Submission copy

Every post below satisfies the brief: it names **MiniMax Code** and **M3.1 Flash**, links a
public artifact, carries the creation note, and uses `#MiniMaxCode`.

> **The public links are filled in.**
>
> | Placeholder | Value |
> | --- | --- |
> | `LIVE_APP` | https://elv2k4rux8xtv.space.minimax.io |
> | `REPO` | https://github.com/nattiini45/minimax-bot-mobile |
> | `VIDEO` | https://github.com/nattiini45/minimax-bot-mobile/releases/download/v0.1.0/demo.mp4 |
> | `APK` | https://github.com/nattiini45/minimax-bot-mobile/releases/download/v0.1.0/minimax-bot-mobile-release.apk |
> | `RELEASE` | https://github.com/nattiini45/minimax-bot-mobile/releases/tag/v0.1.0 |
> | `SCREENSHOTS` | https://elv2k4rux8xtv.space.minimax.io/screenshot-trace.png · https://elv2k4rux8xtv.space.minimax.io/screenshot-team.png |
>
> The live app already points at the deployed relay
> (`https://minimax-bot-relay.nattiini45.workers.dev`), so a stranger only has to type the
> six-digit code the desktop shows.
>
> The demo video and the Android APK live on the v0.1.0 release, so they survive anything
> that happens to the site hosting the live client.
>
> **Keep every post public** until the winners are announced. Do not delete, edit to hide, or
> post to a private channel only.

## Post these three

| # | Where | What | Size |
| --- | --- | --- | --- |
| 1 | Discord → `🧩丨show-your-case` | the block in section 1 | 1 857 characters, one message |
| 2 | Reddit → one technical subreddit | the title and body in section 2 | 121 + 3 234 characters |
| 3 | X → one thread | the six posts in section 3 | each under 280 characters |

**Order matters.** Post the Discord entry first: it is the one the contest actually collects.
Post it *before* Nov 3 — ideally by Nov 1, so there is time to fix anything that breaks.

**Reddit, one choice.** `r/reactnative` reaches the people who would actually use this and
allows project posts; `r/SideProject` is the most permissive about self-promotion. Either
works — a technical write-up reads as a write-up, not an advertisement. Do not post the same
body to both. Check the subreddit's rules before you post.

**What must be visible in every post:** the live link, the source link, the demo video link,
the words *MiniMax Code* and *M3.1 Flash*, and `#MiniMaxCode`.

**What must never appear:** a pairing code, a token, a local file path, a real name, or
anything from the team's private memory. The screenshots carry none of it. The video carries
no credential and nothing from the team's memory, but it does show one path from the
author's own machine — `C:\Users\<name>\.minimax\plugins\minimax-bot-bridge` — in the answer
the model gave about the project. Check whether that should be re-recorded before the video
goes out.

---

## 1. Discord — `🧩丨show-your-case`

This is the entry point. Post it in the channel, and post it *before* Nov 3.

```
Built a native mobile app for the @minimax-bot team — one codebase for Android, iOS and PWA —
with MiniMax Code and M3.1 Flash. #MiniMaxCode

Live app (open it, it is the real client): https://elv2k4rux8xtv.space.minimax.io
Source: https://github.com/nattiini45/minimax-bot-mobile
Demo video: https://github.com/nattiini45/minimax-bot-mobile/releases/download/v0.1.0/demo.mp4
Android APK: https://github.com/nattiini45/minimax-bot-mobile/releases/download/v0.1.0/minimax-bot-mobile-release.apk

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

Then I had three independent reviewers read the code with fresh eyes, having never seen how it
was written. They found six more defects that would have shipped — among them a regression
test that passed against the very code it was meant to catch, and a tool trace that measured
the wrong call whenever the same tool ran twice in a turn. 472 tests pass now, and the new
ones were written to fail against broken code.

Creation note: https://github.com/nattiini45/minimax-bot-mobile/blob/main/docs/CREATION-NOTE.md
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
Live app (the real client, in a browser): https://elv2k4rux8xtv.space.minimax.io
Demo video: https://github.com/nattiini45/minimax-bot-mobile/releases/download/v0.1.0/demo.mp4
Android APK: https://github.com/nattiini45/minimax-bot-mobile/releases/download/v0.1.0/minimax-bot-mobile-release.apk

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

And then I did the thing I should have done first: I had three independent reviewers read
the code with fresh eyes, having never seen how it was written. They found six more defects
that would have shipped — including a regression test that passed against the very code it
was meant to catch, because it sent its frames in an order where the bug could not fire.
One of them rebuilt the pre-fix code in a sandbox to prove it; another transpiled the real
store and drove it through eight frame orderings. Both found things I had read past.

All of it was built with M3.1 Flash in MiniMax Code. The full story, including the limits I
did not fix, is here: https://github.com/nattiini45/minimax-bot-mobile/blob/main/docs/CREATION-NOTE.md

472 tests pass across the four packages, and the end-to-end run is against a live team — real
pairing code, real streamed reply, real dispatched task, real memory entries.

Questions welcome. Especially about the relay design and the build pipeline.
```

---

## 3. X / Twitter

Post as a thread — six posts, each under X's 280-character limit. Attach the screenshots to
the first post.

**Post 1/6**

```
I built a native app for the @minimax-bot team.
Android, iOS and PWA from one codebase, with M3.1 Flash in MiniMax Code. #MiniMaxCode
```

**Post 2/6**

```
The model did the engineering, not just the typing.
It worked against a live six-bot team and found six real bugs — including a build-pipeline trap that shipped a stale package and crashed the app on launch.
```

**Post 3/6**

```
My client was throwing away tool-call events the bridge already sent.
Wiring them up turns a reply from a long silence into a live trace:

  tool_search · 15ms
  mcp_invoke · 20ms
```

**Post 4/6**

```
Then three independent reviewers read the code with fresh eyes.
They found six more defects that would have shipped — including a regression test that passed against the very code it was meant to catch.
```

**Post 5/6**

```
Live app (it is the real client, not a mock):
https://elv2k4rux8xtv.space.minimax.io
Source: https://github.com/nattiini45/minimax-bot-mobile
```

**Post 6/6**

```
Demo video and the signed Android APK:
https://github.com/nattiini45/minimax-bot-mobile/releases/download/v0.1.0/demo.mp4
https://github.com/nattiini45/minimax-bot-mobile/releases/download/v0.1.0/minimax-bot-mobile-release.apk
```

---

## Checklist before the deadline

- [ ] The live link opens from a logged-out browser (test it in a private window).
- [ ] The demo video shows the real app: pairing, a streamed reply, the live trace.
- [ ] All three posts name **MiniMax Code** and **M3.1 Flash**, and carry `#MiniMaxCode`.
- [ ] The Discord entry is posted in `🧩丨show-your-case` with the public link + creation note.
- [ ] No token, pairing code, local path or personal data appears in any screenshot or clip.
- [ ] Every post is still public, and will stay public until the winners are announced.
