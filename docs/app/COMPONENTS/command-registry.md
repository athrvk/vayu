---
description: >-
  The command registry of the Vayu desktop app (lib/commands/): where every user-facing action is declared once.
---

# Command Registry (`lib/commands/`)

Every user-facing *action* the app offers by name, declared once. **A new action is declared
here, and its surfaces point at it** - a menu item, a tile or a palette row is a way of reaching
a command, never a second definition of one. Before this, "open settings" existed separately in
the native-menu bridge, the Dock, the settings sidebar and a keydown case, and nothing kept them
in step or could enumerate them.

- **`types.ts`** - `Command` (`id`, `title`, `keywords`, `substringKeywords?`, `group`, `icon`,
  `shortcut?`, `available?`, `perform`) and `CommandContext`. A `title` may be a function of the context, which
  is how a contextual command names its target: `Run "payments"`, not `Run collection`. A
  `shortcut` is the `Chord` from `constants/shortcuts.ts` that already runs this command - the
  object the handler matches, so a surface printing it cannot advertise a key nothing answers
  (#938) - and is present only where such a chord genuinely exists.
- **`registry.ts`** - the roster. Actions (new request, import, run collection, send, load test,
  copy for agent - `Copy "<tab>" for agent`, the active tab's `agentReference` from its
  descriptor, absent on a tab that names no entity (#2047) - close tab, save, toggle drawer, toggle context bar, toggle response position - request tabs
  only, toggle theme, open settings) plus one
  command per drawer view - **generated** from `constants/drawer-views.ts`, the same table `ActivityRail`
  reads, filtered to drop Settings (which `open-settings` already covers, tab and all) - plus one
  command per run-export action, **generated** from `runExportActions` (`lib/run-export-formats.ts`),
  the list the Export menu draws (`Save "<tab>" as JSON`, `Copy "<tab>" as Markdown`; available only while a mounted menu fills
  `exportRun`, no chord) - plus one command per settings section, **generated** from `app-panels.ts` and `engine-categories.ts` so
  a section added there appears here without an edit and cannot be named differently. A section's
  description is its `substringKeywords` entry, never words in `keywords` (#3322). **Save is
  offered only on a request, collection, settings or variables tab** (`SAVEABLE_TAB_TYPES`) - the
  tabs whose surface registers a save context; on a run, dashboard, welcome, inbox or mock-server
  tab there is nothing to save and the row is absent (#3402).
- **`context.ts`** - `baseCommandContext()`, the React-free snapshot for a caller that is not a
  render (the native-menu bridge). `hooks/useCommandContext.ts` is the full version.
- **`live-surfaces.ts`** - the channel a *mounted feature* contributes a surface through. Four
  named slots: start-load-test and send, contributed by the mounted request builder,
  export-run, contributed by a finished load run's Export menu, and the builder's editor draft,
  read by the context bar's Code section rather than by a command.

Two rules make it work without a dependency-injection tangle:

- **Stores are not in the context.** They are module singletons, so a `perform` calls
  `useTabsStore.getState().openTab(...)` directly. The context carries only what `getState()`
  cannot answer: the active tab, its label and its reference line, the collection that tab
  shows, and the surfaces.
- **A command that needs a surface the caller cannot offer declares itself unavailable** rather
  than throwing when picked. `CommandSurfaces` is optional on the context; the menu bridge omits
  it, so "New request" is simply not among the commands it can run.

## When a surface is a store, and when it is a live contribution

Most of what a `perform` needs is a store, and a store is always the answer when the state
outlives any one mounted view. `CommandSurfaces` covers the rest, and it has two halves:

- **Host-owned** (`newRequest`, `runCollection`, `toggleThemeMode`, `copy`) - dialogs and hooks
  that are React but that *any* rendering caller can mount for itself. The palette does exactly
  that in `useCommandSurfaces`, so offering `surfaces` at all means offering these four.
- **Contributed by a mounted feature** (`startLoadTest`, `sendRequest`, `exportRun`) - state that exists only
  inside one component tree and cannot be lifted without copying it. Starting a load test needs
  the request builder's **live editor draft**, before autosave has run; the palette is a sibling of
  `RequestBuilderProvider`, so a command reading a store would find only the last *saved* request
  and would silently run the old URL after an edit. The builder publishes its own handler through
  `live-surfaces.ts` (`useRegisterLoadTestSurface`, mounted by
  `modules/request-builder/components/LoadTestCommandSurface.tsx`), `useCommandSurfaces` merges
  what is registered, and the command is `available` exactly while that contribution stands - so
  it is absent rather than inert while no builder is on screen, and closing the tab removes it.
  Nothing about the load test moves: the builder's handler asks the single-run gate
  (`canStartLoadRun`, `stores/run-gate.ts`, shared with the Run Collection dialog and agent
  runs; the dialog's callout also offers Stop through `useStopLiveRun`), and the ceilings check and `LoadTestConfigDialog` stay in the builder.

  Send has the identical live-draft problem, so it fills the second slot the same way -
  `useRegisterSendRequestSurface`, mounted by
  `modules/request-builder/components/SendRequestCommandSurface.tsx`. Its contribution is
  conditional where the load test's is not: the builder passes `null` in place of the handler
  whenever `canSendRequest` (`utils/send-gate.ts`) says a send would be refused - a request already
  in flight, this builder's own stream open (where the button reads Stop), or an empty URL - and
  the row disappears with it rather than sitting on screen offering something the Send button
  would refuse.

  A finished load run's export fills the third slot, `exportRun` (#2139), through
  `useRegisterExportRunSurface`, mounted by `modules/history/main/components/RunExportMenu.tsx`.
  What an export sends depends on that menu's comparison toggle, so the handler takes a
  `RunExportAction` and delivers it as the menu's own item would. It is withdrawn while an export
  is in flight. Only the active tab's view is mounted (`renderTabContent` in `Shell.tsx`), so the
  run tab's menu and the dashboard's never hold the slot at once; the identity-checked clear
  covers the hand-over.

  The fourth slot, `editorDraft` (#2638), is a read rather than a command, and is not on
  `CommandSurfaces`. The context bar's Code section has Send's live-draft problem - a snippet of
  the saved row is the old URL after an edit - so the builder publishes a getter over its draft
  and the collection chain it composes Send with (`useRegisterEditorDraftSurface`, mounted by
  `modules/request-builder/components/EditorDraftSurface.tsx`), and the section builds its compose
  body from it with `buildComposeBody`, the builder Send uses. The draft sits in a ref behind the
  getter, so typing writes no store; the slot is republished only when the builder's request id
  changes, and `editorDraftFor(requestId)` answers only for the draft whose own id matches.

The rejected alternative is worth naming, because it is the tempting one: reading the draft out
of the provider from outside it, or recomposing the payload inside the command, would be a second
copy of `buildExecBody` and of the run policy - the "hand-rolled copy of a primitive" defect this
registry exists to remove. The `editorDraft` read does not reopen that door: what it hands out is
the builder's state, and the body is still built by the one shared builder.

The channel is deliberately a **closed union of named slots**, not a registry of arbitrary named
surfaces. Send had the same live-draft problem, and #1243 gave it the second slot rather than a
second channel; #2139 gave the run export the third and #2638 the editor draft the fourth.
`LiveSurfaceSlot` is the keys of one handler table in `live-surfaces.ts` -
`"startLoadTest" | "sendRequest" | "exportRun" | "editorDraft"` - and nothing else, so a fifth
feature with this problem is a decision taken there, not a name a caller can invent by passing a
string.

Consumers: `modules/palette/sources/commandItems.ts` (the Commands and Settings groups) and
`hooks/useMenuActions.ts` (Settings… → `open-settings`). `lib/commands/registry.test.ts` walks
the roster and asserts every entry says something and that the settings roster still covers both
catalogues; `modules/request-builder/load-test-command-surface.test.tsx` holds the live channel to
handing over the request *as edited*, and to clearing itself on unmount.
`modules/request-builder/send-request-command-surface.test.tsx` holds the same for Send - the
request crossing the channel *as edited*, not as last saved - plus the gate: it asserts the row is
absent while the URL is empty, while a send is already in flight, and while this builder's own
stream is open. `modules/history/main/components/RunExportMenu.test.tsx` holds the export slot:
filled while the menu is mounted, cleared on unmount, withdrawn while an export is in flight, and
delivering with the menu's comparison toggle.
`modules/request-builder/editor-draft-surface.test.tsx` holds the draft slot: the read is the draft
as edited with its chain, one publication across edits, republished on a request switch, refused
for another request, cleared on unmount. `code-section-send-parity.test.tsx` beside it drives Send
and the Code section with one draft and asserts the two compose bodies are equal.
