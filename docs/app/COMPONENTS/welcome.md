---
description: >-
  The welcome module of the Vayu desktop app: the new-tab surface.
---

# Welcome (`modules/welcome/`)

Vayu's new-tab surface - rendered for the `welcome` tab (opened by TabStrip's `+`), when no tab is open, and for a request tab with no entity.

It is **not** a resume screen: `openTabs`/`activeTabId` are persisted and restored, so returning users land back on their own tabs. Its job is to start something new. Keep marketing content off it - a feature pitch and static perf claims were removed for exactly that reason. The one exception is `FirstRunWelcome`, which carries a single plain sentence on what Vayu is and an agent-connect row (#2122); no figures, nothing on the Launcher. Anything already visible in the Collections sidebar or History drawer is a duplicate and does not belong here either.

- `WelcomeScreen.tsx` - container: queries, picks the state. Holds on `isLoading` so the first-run screen never flashes at a returning user. The new-request flow itself is `hooks/useNewRequest.ts`, shared with the palette's `new-request` command - two entry points must not disagree about where a request lands. This screen renders that hook's `pickerProps` and nothing more.
- `FirstRunWelcome.tsx` - fresh workspace. Import leads (people arrive carrying Postman/Insomnia/OpenAPI collections). The only state with branding. Also carries the "Connect your coding agent" row, which opens Settings on the MCP section through `lib/commands/reveal-settings.ts`'s `revealSettingsCategory` (shared with the palette's settings commands).
- `Launcher.tsx` - populated. Action row, recent runs, workspace counts. No branding; the logo is in the title bar.
- `components/` - `ActionTile`, `RecentRuns` (a run's row names what was run: the URL and method
  badge, or for a collection run the collection's name, resolved from
  `summary.scenario.collectionId` through the collections query and falling back to the id once
  the collection is deleted, with no method badge; the status word takes the run's verdict, so a
  collection run with failed or errored steps reads "Completed" in the error colour, #3496),
  `FooterLinks`. The action row is six tiles: New
  request, Search, Import, History, Variables, Services. Services and History both reveal a
  drawer view (never close it) rather than opening a tab. Search opens the command palette - the
  chord alone is undiscoverable, and this grid is where the app teaches its own surfaces.
- `components/CollectionPicker.tsx` - the "Add request to" dialog, shown when a new request has no remembered collection. A nested collection shows its parent path (`collectionPath`) under its name, because two same-named folders under different parents are otherwise the same row (#1881).
- `components/DemoApiTile.tsx` - "Open Demo API" (issue #1694), its own row below the action grid
  rather than a seventh cell in it, since the grid's tiles are icon-and-label only with no room for
  "press this chord to send it". Shown only while `runs.length === 0`; retires the moment a run
  exists, with no dismiss of its own. Opens `demo-request.ts`'s preset through the same
  `useNewRequest` targeting as every other "New request" entry point.
- `llm-request-presets.ts` - the two LLM request templates (#3778), module constants of `useNewRequest`'s `RequestPreset` shape: auth, headers marked with the setting that owns them (`stream`, `body-mode`, as `auto-header.ts` writes them), JSON body, `streamTextPath` taken from `STREAM_TEXT_PATH_PRESETS`, and a closing `assert.contains`. Host, key and model are the `{{baseUrl}}`, `{{apiKey}}` and `{{model}}` variables; there is no price table or model list. Offered from the Collections sidebar's template menu and the palette, not from this screen. `llm-request-presets.test.ts` holds each element to the engine's kind schema.
- `LauncherSkeleton.tsx` - one skeleton tile per real tile. It has drifted a tile behind the
  Launcher before; `WelcomeScreen.test.tsx` now asserts both grids against one constant.

Doc links go through `window.electronAPI.openAppLink(key)`, a keyed IPC channel (keys in `electron/app-links.ts`) - the renderer cannot open arbitrary URLs, and a plain `<a target="_blank">` would spawn an unmanaged Electron window.

Design rationale: `app/src/modules/welcome/README.md`
