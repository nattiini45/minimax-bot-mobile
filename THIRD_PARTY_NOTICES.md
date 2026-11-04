# Third-party notices

The root MIT license covers this project's own contributions. It does not replace the licenses of dependencies, third-party artwork, or material supplied by a user's desktop.

## MiniMax Bot artwork and group layout

The launcher artwork is derived from the official [MiniMax Code MiniApps repository](https://github.com/MiniMax-AI/MiniMax-Code-MiniApps), under the MiniMax Bot plugin's [MIT license](https://raw.githubusercontent.com/MiniMax-AI/MiniMax-Code-MiniApps/main/plugins/minimax-ai/minimax-bot/LICENSE).

Source revision used for the provenance comparison: `8abfa3230fe98c9515f1c87d338ef5b6e3a8088c`.

- The icon set in `apps/app/assets` is generated from the plugin's skin artwork by `scripts/make-app-icon.mjs`.
- Group-layout constants in `apps/app/src/components/GroupMark.tsx` and the icon generator are adapted from the plugin's [`miniapp/client/octopus.js`](https://raw.githubusercontent.com/MiniMax-AI/MiniMax-Code-MiniApps/8abfa3230fe98c9515f1c87d338ef5b6e3a8088c/plugins/minimax-ai/minimax-bot/miniapp/client/octopus.js).
- The bridge's `icon.png` and `icon-dark.png` use the same generated icon and adaptive foreground as the app.
- The complete MiniMax copyright and permission notice is preserved in `apps/app/assets/LICENSE-MINIMAX.txt` and `packages/bridge/LICENSE-MINIMAX.txt`.

Copyright (c) 2026 MiniMax. See the retained MIT notice for permission conditions and warranty disclaimer.

Bot and group pictures shown inside the running application are requested from the user's desktop at runtime. Uploaded or customized pictures may have separate ownership and permission requirements; a runtime connection does not grant redistribution rights.

## Dependencies

JavaScript, native and build-tool dependencies retain their own licenses. Their package metadata, license files and applicable distribution notices remain authoritative. The root license does not relicense those packages.

## Names and trademarks

MiniMax, MiniMax Code and MiniMax Bot names and marks remain those of their respective owners. This independent companion is not endorsed by MiniMax. Neither the project MIT license nor the upstream artwork license grants trademark rights.
