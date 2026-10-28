# Design tokens

The visual source of truth is the **MiniMax Bot product skin** — the `app.css` that
ships with the official `@minimax-bot` Mini App. Its own header states the intent:
*"visual language follows DS Bot's team surface, adapted to MiniMax Code"*.

This app does not invent a second design language. Every colour, radius, type size,
weight, duration and font stack below is lifted from that skin, so a phone screen
and a desktop screen running the same team look like the same product.

The tokens live in `apps/app/src/theme/tokens.ts`. `apps/app/src/theme/index.ts`
turns them into a React Native theme and picks the light or dark set from the OS
colour scheme.

## Why the skin and not a platform layer

The plan originally assumed a `--mcode-*` CSS custom property layer for platform
chrome. That layer does not exist: `miniapp-surface.js` in the Host is a contract
module, not a stylesheet. The only real token source is the Bot skin's own
`app.css`. This is a documented deviation, not a shortcut.

## Colour

Twenty-two semantic tokens, each with a light and a dark value. They are named by
role, never by hue, so a theme swap never touches a component.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#fcfcfc` | `#141414` | App background |
| `sidebar` | `#f7f7f7` | `#1b1b1b` | Side panels, tab bar |
| `surface` | `#ffffff` | `#1f1f1f` | Cards, raised sheets |
| `bubble` | `#efefef` | `#262626` | Incoming message bubble |
| `user` | `#0a0a0a` | `#f2f2f2` | Outgoing message bubble (fill) |
| `userInk` | `#fcfcfc` | `#141414` | Text on the outgoing bubble |
| `ink` | `#141414` | `#f2f2f2` | Primary text |
| `muted` | `#6e6e6e` | `#9a9a9a` | Secondary text |
| `subtle` | `#a1a1a1` | `#6b6b6b` | Tertiary text, timestamps |
| `line` | `rgba(20,20,20,.08)` | `rgba(255,255,255,.08)` | Hairline dividers |
| `lineStrong` | `rgba(20,20,20,.16)` | `rgba(255,255,255,.16)` | Emphasised dividers |
| `hover` | `rgba(119,119,119,.09)` | `rgba(160,160,160,.12)` | Pressable fill |
| `active` | `rgba(119,119,119,.16)` | `rgba(160,160,160,.20)` | Selected state |
| `tag` | `rgba(20,20,20,.06)` | `rgba(255,255,255,.09)` | Chips and badges |
| `star` | `#ff9800` | `#ff9800` | Favourite, primary bot |
| `danger` | `#e5323f` | `#f05561` | Destructive actions |
| `success` | `#12a150` | `#2fc06b` | Healthy state |
| `warning` | `#e46a12` | `#f08a3c` | Degraded state |
| `scrim` | `rgba(10,10,10,.28)` | `rgba(10,10,10,.50)` | Modal backdrop |
| `shadowPop` | two-layer soft shadow | two-layer soft shadow | Popovers and sheets |
| `shadowPill` | two-layer soft shadow | `0 2px 10px -1px rgba(0,0,0,.5)` | Floating pills |
| `ring` | `#f7f7f7` | `#1b1b1b` | Focus ring track |

The dark set is not an inversion. Dark surfaces sit at `#141414`/`#1b1b1b`/`#1f1f1f`
rather than pure black, and the semantic accents are lightened (`danger`
`#e5323f` → `#f05561`) so they stay legible on a dark ground.

The `user` / `userInk` pair is deliberate: the outgoing bubble is a near-black
chip in light mode and a near-white chip in dark mode, with the ink flipped to
match. It is the only place the app inverts, and it keeps the conversation
readable in both schemes.

## Radius

| Token | Value | Use |
|---|---|---|
| `xs` | 5 | Tags, tiny badges |
| `sm` | 6 | Inline chips |
| `md` | 8 | Inputs, small buttons |
| `lg` | 10 | Buttons |
| `xl` | 12 | Cards |
| `xxl` | 14 | Large cards, sheets |
| `card` | 14 | List rows |
| `bubble` | 18 | Message bubbles |
| `pill` | 999 | Fully rounded controls |

Message bubbles use `bubble` (18) so a short reply and a long reply read as the same
object, while list rows use `card` (14) so they read as surfaces.

## Type scale

Eleven sizes from `micro` to `hero`, plus `code`.

| Token | px | Token | px |
|---|---|---|---|
| `micro` | 11 | `title` | 18 |
| `caption` | 12 | `titleLarge` | 19 |
| `footnote` | 13 | `display` | 20 |
| `body` | 14 | `displayLarge` | 21 |
| `bodyLarge` | 15 | `hero` | 23 |
| `callout` | 16 | `heroLarge` | 24 |
| `headline` | 17 | `code` | 40 |

`body` (14) is the default reading size for messages and rows; `bodyLarge` (15) is
the composer; `callout` (16) is used wherever the OS would otherwise zoom.

### Weights

`regular` 400 · `medium` 500 · `semibold` 600 · `bold` 700.

### Fonts

```
sans:  ui-sans-serif, -apple-system, system-ui, "PingFang SC", "Segoe UI", Helvetica, Arial, sans-serif
mono:  "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace
```

The system stack means the app inherits the platform's own type rendering — SF on
iOS, Roboto on Android, the system UI font on the web — instead of shipping a web
font that would blur and add a megabyte to the PWA.

## Motion

| Token | ms | Use |
|---|---|---|
| `fast` | 120 | Colour, opacity, transform |
| `base` | 150 | Larger transforms, sheet motion |
| `slow` | 200 | Padding, layout settles |

All three are `ease`. The native app uses exactly these durations so a message
arriving on a phone lands with the same rhythm as one arriving on the desktop.
Anything longer than 200 ms is a deliberate exception and should be justified in
the component that uses it.

## Spacing

`xs` 4 · `sm` 8 · `md` 12 · `lg` 16 · `xl` 24 · `xxl` 32.

## Input rule

`MIN_INPUT_FONT_SIZE` is 16. Any `TextInput` that can take focus uses at least this
size, so iOS Safari and Android Chrome never zoom the viewport on focus. The web
build inherits the same rule.

## Applying tokens

```tsx
import { useTheme } from '../theme';

function Row() {
  const theme = useTheme();
  return (
    <View style={{ backgroundColor: theme.colors.surface, borderRadius: theme.radius.card }}>
      <Text style={{ color: theme.colors.ink, fontSize: theme.fontSize.body }}>…</Text>
    </View>
  );
}
```

Components must not hardcode a colour, radius or duration. If a value is needed
that the token set does not cover, it is added to the token set first, so the
desktop and the phone stay in step.

## Avatars

Bot avatars are **drawn in code** — the octopus shapes from the official skin's
twelve looks (`fuzzy`, `bubble`, `glass`, `gold`, `jade`, `plush`, `waffle`,
`pixel`, `smiley`, `toys`, `moon`), each with its palette. The PNG assets in the
official plugin are not copied: the plugin cache is hash-verified and must never be
modified, and the app renders the same vocabulary from vectors so it scales to any
density without a second asset pipeline.

See `apps/app/src/components/Avatar.tsx`.
