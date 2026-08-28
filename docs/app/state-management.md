---
description: >-
  State in the Vayu app: Zustand stores for UI state, TanStack Query for server state, the query keys, and the cache policy.
---

# State Management

The Vayu app uses a dual-state management approach: **Zustand** for UI state and **TanStack Query** for server state. **Cross-cutting stores** (tabs, layout, session, engine, save, response, dashboard, client settings, toasts, import modal) live in `app/src/stores/` and are exported via the barrel `app/src/stores/index.ts`. **Module-local UI stores** co-locate in `app/src/modules/<feature>/<feature>-store.ts` (collections, history, variables, settings) to keep feature-specific UI state decoupled from global app state.

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│           State Management Layers                │
├─────────────────────────────────────────────────┤
│  UI State (Zustand)                             │
│  - Cross-cutting: tabs, layout, session         │
│  - Domain: engine, save, response, dashboard    │
│  - Module-local: collections, history, vars     │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Server State (TanStack Query)                  │
│  - Collections, Requests, Environments           │
│  - Runs, Metrics, Global Variables              │
│  - Automatic caching & synchronization          │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Services Layer                                 │
│  - HTTP Client (api.ts)                        │
│  - SSE Client (sse-client.ts)                  │
└─────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Vayu Engine (C++ Daemon)                      │
│  - SQLite Database                              │
│  - HTTP API (localhost:9876)                    │
└─────────────────────────────────────────────────┘
```

## Zustand Stores

### Cross-Cutting Stores (`app/src/stores/`)

#### `tabs-store.ts` - Open Tabs & Navigation

Manages all open tabs (welcome, request, collection, dashboard, run, variables, settings) and active tab focus. Enforces a maximum of 12 open tabs with LRU eviction for non-exempt types.

**State:**
```typescript
{
  openTabs: Tab[]                        // Each tab has unique id, type, and optional entityId
  activeTabId: string | null
  tabFocusedAt: Record<string, number>   // Tab id -> when it was last focused (epoch ms)
  specTabTarget: string | null           // Collection whose Spec tab something pointed at
  dataRowTarget: { requestId, rowIndex } | null  // Request a repro pointed at, and the row
}
```

**Key Features:**
- Deduplication: Singleton types (welcome, variables, settings, inbox) only allow one tab at a
  time. Opening one that is already open with a *different* `entityId` **retargets** it - same tab
  id, new address - rather than focusing whatever it was showing. The inbox tab is the case that
  needs it: every Services drawer row opens that one tab pointed at its own inbox (issue #554).
  The other three are always opened with a null `entityId`, for which this is a no-op
- LRU eviction: Oldest non-active, non-exempt, clean tabs are closed when over limit
- Integration with save-store: dirty tabs are never selected for eviction. The
  guard resolves each tab's save-context key by tab *type* (`isTabDirty`),
  because the registry is keyed by editor and the two do not line up: `settings`
  and `variables` are singletons with no `entityId`, so a `request-${entityId}`
  lookup read them as clean and the 13th tab could close a dirty Settings tab.
  A `variables` tab counts any dirty variable-editor context as its own, since
  a `Tab` does not record which editor the sidebar has selected - over-matching
  keeps a tab that could have closed, under-matching loses work. Nothing is
  flushed *during* eviction; the predicate already refused the tab
- Response eviction: `closeTabsForEntities` clears each id's entry in
  `response-store`. Both callers reach it after a delete, and nothing else
  evicts from that map
- Focus recency: `tabFocusedAt` stamps `openTab` and `focusTab`, and is read by
  the command palette, which lists open tabs most-recently-used first. It cannot
  come from `openTabs`, which is insertion order - the tab you were just in sits
  wherever it was opened. Session-scoped on purpose (absent from `partialize`):
  tabs *are* restored across launches, so a persisted copy would rank a restored
  list by yesterday's attention, and an empty map falls back to strip order.
  Entries for closed tabs are dropped on the next focus rather than in every
  close path - nothing reads a stamp for a tab that is not open
- Pointing *into* a collection: `openTab` can only name a collection, and a
  collection tab picks its own sub-tab, so `specTabTarget` is where the one
  navigation that means a *section* says which. The import dialog sets it when a
  re-import is answered with Sync (issue #680); `CollectionDetail` opens on Spec
  when the named collection is on screen and clears it, so it survives the tab
  opening for the first time and never fires twice. Session-scoped like
  `tabFocusedAt` - a persisted copy would jump the user to Spec on the next
  launch for a choice they made yesterday
- Pointing *into* a request the same way: `dataRowTarget` carries the data row a
  navigation meant, because `openTab` can only name a request and which row
  Send-with-row binds is state the UrlBar holds. A failed step of a collection
  run sets it through `openRequestWithDataRow` (issue #730) - "reproduce this
  step" means its request *and* the row that iteration bound - and the UrlBar
  selects the row, opens the picker on it and clears the target, whether or not
  the request can bind rows at all: a target left standing would fire on the
  next request that can. Session-scoped like `specTabTarget`, and doubly so -
  it points into a data file whose rows are deliberately never persisted, so a
  remembered index would name a different row in a file that has since changed.
  A non-integer or negative index throws rather than being stored
- Persistence: `vayu.tabs` (v1), with a pass-through `migrate`. zustand discards
  a payload whose *stamped* version differs from the store's when no `migrate`
  is supplied, so the stub is where the next bump goes; it also refuses a
  payload of the wrong shape rather than handing a non-array to every reader

**Key Methods:**
```typescript
const { openTab, closeTab, focusTab, closeTabsForEntities } = useTabsStore();
openTab({ type: "request", entityId: "req-123" });
closeTabsForEntities(["req-123"]); // after a delete: closes tabs, drops responses
openCollectionSpecTab("col-123"); // opens the collection, on its Spec tab
openRequestWithDataRow("req-123", 500); // opens the request, on row 501 of its data file
```

#### `layout-store.ts` - Drawer, Context Bar, & Split Ratio

Manages the left drawer (collections/history/variables/settings), the right context bar, and request/response split ratio.

**State:**
```typescript
{
  drawerOpen: boolean                    // Is the left drawer visible?
  drawerView: DrawerView                 // "collections" | "history" | "variables" | "services" | "settings"
  drawerWidth: number                    // One width for every view
  contextBarOpen: boolean                // Is the right context bar visible?
  contextBarWidth: number
  contextBarCollapsedSections: string[]  // Section ids the user collapsed
  requestSplitRatio: number              // 0–1; left/request pane fraction
  paletteOpen: boolean                   // Is the ⌘K command palette showing?
}
```

**Key Methods:**
```typescript
const {
  drawerOpen, setDrawerOpen, toggleDrawer,
  drawerView, setDrawerView, activateDrawerView,
  drawerWidth, setDrawerWidth,
  contextBarOpen, setContextBarOpen, toggleContextBar,
  contextBarWidth, setContextBarWidth,
  contextBarCollapsedSections, toggleContextBarSection,
  requestSplitRatio, setRequestSplitRatio
} = useLayoutStore();
activateDrawerView("variables"); // Open drawer to variables, or toggle closed if already there
setDrawerWidth(300); // Clamped to [PANEL_MIN_WIDTH, PANEL_MAX_WIDTH] (constants/layout.ts)
```

**One drawer width, not one per view.** v2 stored a width per view, so switching
from Collections to History resized the main content under the user; the **v3**
migration collapses them onto a single `drawerWidth`, keeping whatever
Collections (the default view) had. Re-introducing a per-view width re-introduces
that bug. `setRequestSplitRatio` clamps to [0.2, 0.8]; both panel widths clamp to
`PANEL_MIN_WIDTH` / `PANEL_MAX_WIDTH`.

**`paletteOpen` is here, and is not persisted.** The palette lives in `Shell`
while the things that open it - the welcome Launcher's Search tile, the title
bar's search bar - are in other subtrees, so the flag has to be shared state
rather than the dialog's own. It is deliberately absent from `partialize`: a
dialog that reopened itself on every launch is not a layout preference.

**Context-bar sections are collapsed by exception.** The store holds the ids the
user closed (`contextBarCollapsedSections`); anything not listed is expanded. Two
consequences worth keeping: a section added in a later release ships *expanded*
for existing users, because a blob written before it existed cannot name it; and
it is an array rather than a `Set` because `persist` serializes with JSON, which
writes a `Set` as `{}` - a collapse would survive exactly until the next launch.
No migration was needed for the field: `persist` merges a missing key onto the
initial state, which is `[]`.

**Persistence:** `vayu.layout` (v3, with real migrations for both bumps - the one
store in the app doing persistence versioning end to end)

#### `session-store.ts` - Active Environment

Tracks the active environment (for variable resolution) and the collection the
user last worked in (a new-request target only), persisted across sessions.

**State:**
```typescript
{
  activeEnvironmentId: string | null
  lastCollectionId: string | null
}
```

**Key Methods:**
```typescript
const { activeEnvironmentId, setActiveEnvironmentId } = useSessionStore();
setLastCollectionId(collectionId);
```

**Persistence:** `vayu.session` (v2)

**A persisted id must not outlive what it names.** `activeEnvironmentId` rides
on every composed payload, so a dangling one is not cosmetic - the switcher
renders "No Environment" through a defensive `find()` while the wire still
carries a deleted id. It is cleared at both ends:
`useDeleteEnvironmentMutation` clears it when the active environment is the one
deleted (in the mutation, so both delete flows are covered), and
`useActiveEnvironmentGuard()` - mounted once in `App.tsx` - clears an id the
engine's environment list does not contain. That guard keys on the query's
`isSuccess`, never on the list being empty: an unreachable engine produces an
empty list too, and clearing on that would discard a good selection whenever
the app started before the engine did.

`activeCollectionId` was **removed** in v2. It had a reader (the resolver's
fallback scope) and no writer, so it was permanently null on a fresh install
and, on an older one, rehydrated a collection the user had long left and
silently scoped `{{var}}` previews to it. The persist `migrate` drops the
stored key. `lastCollectionId` is the field that looks similar and is not: it
has a real writer and feeds only the welcome screen's new-request target - it
must never feed the resolver.

The migration rebuilds the payload from the fields v2 knows rather than deleting
that one key, which is also the shape check: a hand-edited or half-written entry
degrades to defaults instead of handing a non-string id to the switcher. That
whitelist is where the next bump goes - zustand discards a payload whose
*stamped* version does not match when no `migrate` is supplied, which is the
same reason `tabs-store` carries one.

**`activeEnvironmentId` is a cache of engine state, not the source of truth.**
The engine owns which environment is active (`environments.is_active`, at most
one row, enforced in its DB layer). The store holds the same id so the
switcher, the resolver and every composed payload can read it synchronously,
and two pieces of wiring keep the two in step:

- `useSetActiveEnvironmentMutation` (`queries/environments.ts`) is the only
  writer. It PUTs `isActive` and updates the store optimistically, rolling the
  store back if the engine refuses - a selection the engine did not accept must
  not survive in the UI, or the next launch silently disagrees with this one. It
  invalidates the environments list rather than patching the response into it,
  because the *deactivated* row changed server-side without appearing in any
  response body.
- `useActiveEnvironmentRestore` (`hooks/`, mounted in `App.tsx`) reconciles on
  launch: adopt the engine's active environment if it has one, otherwise push a
  persisted id that names an environment that still exists - once per session,
  so a write the engine keeps rejecting is a failed write and not a request
  loop. Both directions wait on `isSuccess`; an unreachable engine returns an
  empty list that is indistinguishable from "no environments exist", and
  adopting from that would clear a good selection on every cold start.
  A third direction was added with the MCP state tools (#758): once this
  session has *seen* the engine hold a selection, an engine that reports none
  is adopted as a clear rather than pushed back at. Otherwise an
  `activate_environment` with `"none"` - or any other client's deactivate -
  would be undone on the very next refetch by this window's memory of the id
  it used to hold. The upgrade push stays for the case it was written for: an
  engine that has never held a selection at all.

It composes with `useActiveEnvironmentGuard` above rather than replacing it, and
is mounted after it: the guard answers "does this id still exist", this hook
answers "which id does the engine hold". Order matters only in the one case
where both would act - a dangling id should be dropped, not pushed back at the
engine as a selection.

Editing an environment's variables deliberately sends no `isActive`
(absent means "keep" on a PUT): echoing a cached value back would let a
variable edit re-activate an environment from a stale read, deactivating
whichever one the engine actually holds.

#### `data-file-store.ts` - Where Each Collection's Data File Lives

Remembers **where** a collection's data file is on this machine, so the Run
dialog can pre-fill it instead of asking for it every run (issue #599).

**State:**
```typescript
{
  locations: Record<string, { path: string; fileName: string }>  // keyed by collection id
}
```

**Key Methods:**
```typescript
const { setDataFile, clearDataFile } = useDataFileStore();
setDataFile(collectionId, { path, fileName });
```

**Persistence:** `vayu.data-files` (v1)

**Two things this store deliberately is not.** It is not the *contract* - the
declared columns are the same on every machine, so they live on the engine's
collection row as `dataSchema` and travel through import; a path is true of one
filesystem only and stays here, never reaching the engine, an export or MCP. And
it never holds **rows**: a data file's contents are user data of unknown
sensitivity and are persisted nowhere in Vayu, which `data-file-store.test.ts`
asserts against the persisted payload rather than against the store's surface.

The path is written when the user declares a contract in the Data tab
(`CollectionDetail/DataTab.tsx`), obtained through the preload's existing
`getFilePath` bridge, and dropped when the collection is deleted or its contract
cleared. Reading it back needs the gated `dataFile:read` IPC
(`electron/data-file.ts`), because the renderer otherwise cannot name a path.

The persisted payload is normalized through **both** `migrate` and `merge`:
`migrate` runs only on a version mismatch, and the common case is a
same-version payload, so an entry that is not a `{path, fileName}` pair of
strings would otherwise reach the read IPC *as a path*. A bad entry is dropped
rather than repaired - there is nothing to repair a path to, and the picker is
one click away.

#### `spec-file-store.ts` - Where Each Collection's Spec File Lives

Remembers **where** a collection's bound OpenAPI document is on this machine, for
the specs that were picked as files rather than fetched from a URL (issue #638).

**State:**
```typescript
{
  locations: Record<string, { path: string; fileName: string }>  // keyed by collection id
}
```

**Key Methods:**
```typescript
const { setSpecFile, clearSpecFile } = useSpecFileStore();
setSpecFile(collectionId, { path, fileName });
```

**Persistence:** `vayu.spec-files` (v1)

The same two-halves law as `data-file-store` above, one contract over: the
**document** is engine state (`spec_documents.content`, hashed there, bound by
`collection.openapi.specId`) because it is the same on every machine and travels
through import; a *path* is true of one filesystem only and stays here. A
URL-sourced spec has no entry at all - its origin is `spec_documents.source_url`,
which is portable and is what a re-fetch will use. And it never holds spec
**content**: a second copy in localStorage could not be hashed and could not be
told apart from the bound one, which `spec-file-store.test.ts` asserts against
the persisted payload rather than against the store's surface.

The path is written when an OpenAPI file is imported (`queries/import.ts`, after
the apply, because the collection has no id until then) or when the Spec tab
binds a picked file, obtained through the preload's existing `getFilePath`
bridge, and dropped on unbind. Reading the files a picked document *references*
needs the gated `specFile:read` IPC (`electron/spec-file.ts`), which takes the
document's path plus the reference and resolves one against the other in the
main process - the renderer names no directory of its own, the same posture
`dataFile:read` holds. It is normalized through **both** `migrate` and
`merge`, for the reason spelled out for `data-file-store` above.

#### `bound-row-store.ts` - The Row The Open Builder Is Bound To

One slot: the data row a Send-with-row has picked, and the id of the request it
was picked for (issue #1074).

**State:**
```typescript
{
  bound: { requestId: string; row: Record<string, unknown> } | null
}
```

**Key Methods:**
```typescript
const setBoundRow = useBoundRowStore((s) => s.setBoundRow);
setBoundRow({ requestId, row }); // or null for "bound to none"
```

**Persistence:** none, deliberately - see below.

**Why a store at all.** `RequestBuilderProvider` already gives the picked row to
its own resolver, which covers every preview inside the builder (issue #1062).
The tab strip is the one that is not below it: `useTabDescriptors` labels every
open tab from a single list-wide resolver, so it cannot take the row off the
builder's context and, left alone, labelled a tab from the environment while the
bar one row beneath it showed the file's value.

**One slot, not a map, and it names its request.** The builder binds a row for
the request it is showing, so that is the only request an on-screen preview can
be bound for; a row per remembered index would be a row out of a file that is no
longer the one loaded. Carrying the request id is what lets a reader check
rather than assume, so a slot left standing cannot relabel the next tab -
`boundRowFor(bound, requestId)` is that check, named once rather than repeated
at each call site.

**Never persisted, and cleared with the builder.** Rows are user data of unknown
sensitivity and are persisted nowhere in Vayu, the same law `data-file-store`
states above; the builder also clears the slot when it unmounts, so a row cannot
outlive the send that justified it.

#### `recovery-notice-store.ts` - Which Data-Loss Notice Was Already Seen

One timestamp: the `at` of the startup-recovery record the user has already been
told about (issue #922).

**State:**
```typescript
{
  acknowledgedAt: number | null  // epoch ms of the dismissed record, or null
}
```

**Key Methods:**
```typescript
const { acknowledgedAt, acknowledge } = useRecoveryNoticeStore();
```

**Persistence:** `vayu.recovery-notice` (v1)

The *record* is the engine's - a marker file beside the database, reported on
`GET /health` for as long as it stands, because a record that cleared itself as
soon as something read it would be lost whenever the engine restarted before the
app polled. Showing a notice about it exactly once is this side's job, and one
timestamp is the whole of it: a later recovery carries a later `at` and is a
different event, so it surfaces again with no per-event bookkeeping. Persisted
rather than session state because "does not repeat on the next launch" is the
point - a window reopened against an already-running engine would otherwise
re-announce a wipe the user had dismissed. A stored value that is not a finite
number reads as "nothing acknowledged", the safe direction: a notice shown twice
is an annoyance, one suppressed by a garbage value is silent data loss again. It
is normalized through **both** `migrate` and `merge`, for the reason spelled out
for `data-file-store` above.

#### `engine-store.ts` - Engine Connection & Restart State

Merged store managing engine connection status and restart-required notifications (for config changes that need an engine restart).

**State:**
```typescript
{
  isEngineConnected: boolean
  engineError: string | null
  recovery: EngineRecovery | null  // What the engine's startup did to the database
  pendingRestart: boolean
  restartRequiredKeys: string[]  // Config keys requiring restart
}
```

**Key Methods:**
```typescript
const {
  isEngineConnected, setEngineConnected,
  engineError, setEngineError,
  recovery, setEngineRecovery,
  pendingRestart, addRestartRequiredKey, clearRestartRequired,
} = useEngineStore();
```

`recovery` is the optional `recovery` node from `GET /health` (issue #922),
written by the same poll that writes `engineError` and read by `RecoveryBanner`.
`null` is a clean start; a value means the engine restored the database from its
backup or deleted it as unrecoverable.

`engineError` is what the failed health poll recorded (`queries/health.ts`), and
the Dock's connection indicator renders it in a tooltip when the engine is down -
"Disconnected" alone read the same for a refused connection, a timeout and a TLS
failure.

**Non-persisted** (cleared on app restart).

#### `save-store.ts` - Centralized Auto-Save

Orchestrates auto-save across the app with a registry of saveable contexts (e.g., request tabs, environment editors). Provides Ctrl/Cmd+S integration and unified save status.

**State:**
```typescript
{
  status: "idle" | "pending" | "saving" | "saved" | "error"
  activeContextId: string | null
  contexts: Map<string, SaveContext>  // Saveable entities
}
```

**`failSave` is the app's single failure seam.** It sets `status: "error"` *and*
raises an error toast carrying the reason. Its call sites are the collection
tree's create / delete / duplicate / rename, `useSaveManager`, `SettingsMain`,
`VariableTableEditor`, `useDraftSaveContext` and the context bar's
`VariablesSection` - and doing the reporting here rather than at each of them
means a new caller cannot forget to report. The last two were added because both
could fail in complete silence: the variables section fired three mutations with
no `onError` at all, and the
manual-draft editors rendered an inline callout that a quit flush has no screen
to show.

`VariablesSection` also **registers a context** (`context-bar-variables`),
because `failSave` alone only covers the failure. A variable commit is a plain
mutation rather than a draft, so it registers one entry for the whole section
whose
`hasPendingChanges` tracks whether any commit is outstanding and whose `save()`
resolves when the last one settles - without it `flushAll` had nothing to wait
for, and the renderer could be torn down mid-PUT with the input already showing
the value as committed.

**Only the context that set a status clears it.** `SettingsMain` used to run an
unconditional `setStatus("idle")` whenever it had nothing pending - which
included mount - so merely opening Settings wiped an `error` another context had
just published to the Dock. It now tracks whether the `pending` on screen is its
own and leaves anything else alone.

The same rule is why **`completeSaveThenIdle` is the only way to report a
success**: it sets `saved` and arms the return to `idle` behind two checks - that
the status is still the `saved` it set, and that no later save has re-armed the
reset since. A bare `completeSave()` followed by
`setTimeout(() => setStatus("idle"), …)` fires regardless of what happened in the
meantime, so a rename that succeeded two seconds ago cleared the failure a delete
had just published; and two saves a second apart had the first one's timer end
the second one's indicator early. `triggerSave` has always guarded the first way,
`useSaveManager` hand-rolled the second as a `clearTimeout` of its own timer.
Both live in the store now, and the six call sites (`useSaveManager`,
`SettingsMain`, `VariableTableEditor`, `VariablesSection`, both collection-tree
renames) share that one implementation rather than five copies of the timer.

`completeSave` is gone with them. It set `saved` and armed nothing, so every
caller either paired it with a hand-rolled timer or - `VariablesSection`, the one
non-draft commit path - left "Saved" in the Dock until something else happened to
change it. The indicator's lifetime is `TIMING.SAVED_STATUS_DURATION_MS`, in one
place, for every surface that saves.

There is no `errorMessage` field. The reason travels in the toast; the store
holds only the status the Dock renders. The field used to exist and its sole
reader was the Dock's error line, which the toast replaced.

There is no `lastSavedAt` or `pendingSaveId` either, for the same reason - every
match on either name was a write inside `save-store.ts`. `status` is the store's
whole public surface, and all five of its values now have a reader: the Dock
renders `pending` as **"Unsaved changes"**, which is the only place in the app
that says so. That matters because auto-save is a setting the user can turn off,
and with it off nothing was written back and nothing said as much (the tab strip
carries no unsaved-dot on purpose).

**`triggerSave` will not report a success the context did not have.** Registered
contexts report their own failures through `failSave` and then *resolve* rather
than rejecting - `useSaveManager`, `SettingsMain` and `VariableTableEditor` all
do - so `runSave` checks for `status === "error"` after awaiting instead of
setting `"saved"` unconditionally. Without that check a failed Cmd/Ctrl+S showed
"Saved" beside its own failure toast.

**SaveContext:**
```typescript
{
  id: string
  name: string
  save: () => Promise<void>
  hasPendingChanges: boolean
}
```

**Key Methods:**
```typescript
const {
  registerContext, unregisterContext, updateContext,
  setActiveContext, getActiveContext,
  triggerSave,       // Ctrl/Cmd+S - saves active or first dirty context
  flushAll           // Save all dirty contexts (used before app quit)
} = useSaveStore();
```

**Non-persisted**. See `useSaveManager` (debounced-autosave editors) and
`useDraftSaveContext` (draft editors, whether they commit on blur or on a
button) for registration details.
Between them every dirty editor in the app is in this registry, which is what
`flushAll` walks on quit - a surface that is not registered is not merely
unsaved on quit, it is invisible.

The registry has a second reader: the collection tree refuses to *drag* a
request whose open tab still has unsaved edits (`contexts.get("request-<id>")
?.hasPendingChanges`, keyed the way `useSaveManager` registers it). Two writers
on one row - a save carrying the row's contents while a reorder rewrites its
owner and order - is the clobber family #237 belongs to, and the drag is the
half that can simply wait.

#### `response-store.ts` - Response Cache

In-memory storage of responses per request ID, persisted across view/tab switches but not to disk.

**State:**
```typescript
{
  responses: Map<string, StoredResponse>
}
```

**StoredResponse:** Includes status, headers, body, execution time, script results, and console logs.

**Key Methods:**
```typescript
const { setResponse, getResponse, clearResponse, clearAll } = useResponseStore();
```

**Eviction:** `clearResponse` runs from `useDeleteRequestMutation` (the delete is
what makes the response unreachable) and from `tabs-store`'s
`closeTabsForEntities` (the collection cascade, which knows every descendant id).
Nothing else drops an entry, so a map with no eviction at all grew for the whole
session - each entry holds a body plus its raw copy.

**Non-persisted** (responses are reloadable from backend).

#### `appearance-store.ts` - Pre-Paint Interface Preferences

The UI font, the interface scale and the corner roundedness - the three
preferences `index.html`'s pre-paint script applies before React mounts. Seeded
from localStorage at module load and written back one key per preference
(`vayu-ui-font`, `vayu-ui-font-custom`, `vayu-ui-scale`, `vayu-ui-radius`), *not*
through zustand's `persist`: the pre-paint script reads those exact keys, and
`SETTINGS_STORAGE_KEYS` clears them on "Reset app settings".

**State:**
```typescript
{
  font: UiFontChoice   // a preset or "custom"
  fontCustom: string   // used when font === "custom"
  scale: number        // page-zoom factor, 0.8-2.0 in 0.1 steps
  radius: UiRadius
}
```

Each action both persists and applies (`--font-sans`, `--radius`,
`webFrame.setZoomFactor`), so there is one write path per preference rather than
a state update and a separate effect that has to agree with it.

**Why a store and not `useState` in `useAppearance`:** scale has two inputs. The
Appearance panel's slider and the View menu's `Ctrl`/`Cmd` `+` `-` `0` move the
same value, and `useAppearance` is mounted twice (the app shell and the panel).
Per-instance state let the panel keep reading "Default" while the window
rendered 133%. The menu bridge (`onZoomCommand` → `nudgeScale`/`resetScale`)
lives in `useMenuActions`, which mounts exactly once - subscribing from
`useAppearance` would move the zoom two steps per keypress.

The scale range, the legacy-preset migration and the clamp/snap live in
`constants/appearance.ts` (`clampScale`, `parseScale`, `nudgeScale`). The
pre-paint script duplicates them by necessity - it runs before any module - and
`appearance.prepaint.test.ts` executes the real script to keep the duplicate
honest.

#### `client-settings-store.ts` - Renderer Preferences

Central home for renderer-only preferences that aren't part of the pre-paint appearance set (theme/color/UI-font/scale/radius live in their own localStorage keys so `index.html` can apply them before React mounts). Holds editor behavior, the monospace/code font, chart granularity, the capacity SLO threshold, the live refresh rate, auto-save preferences, reduced motion, the notification preferences and the load-test dialog's ceilings. Backs the Settings **panels** (`modules/settings/main/panels/`). Non-React consumers (services, the dashboard store) read via `getState()`.

**State:**
```typescript
{
  editor: EditorPrefs            // fontSize, wordWrap, minimap, lineNumbers, tabSize
  monoFont: MonoFontChoice       // a preset or "custom"
  monoFontCustom: string         // used when monoFont === "custom"
  chartBucketSeconds: number     // time-bucket width for the dashboard charts
  sloThresholdMs: number         // p99 latency the capacity breakpoint triggers at
  liveRefreshMs: number          // how often live metrics commit into the store
  autoSave: AutoSavePrefs        // { enabled, delayMs }
  reducedMotion: boolean         // mirrored onto <html data-reduced-motion>
  notifications: NotificationPrefs  // position, durationScale, maxVisible, minSeverity
  loadTestCeilings: LoadTestCeilings
}
```

```typescript
import { SETTINGS_STORAGE_KEYS } from "@/stores";  // localStorage keys reset by "Reset app settings"
```

`monoFont` and `reducedMotion` also touch the DOM (`--font-mono`,
`data-reduced-motion`), so their setters and `onRehydrateStorage` both apply
them - a preference that only lands on the next reload reads as a broken
setting.

`loadTestCeilings` is the one slice with a bound outside the app: each value is clamped to `LOAD_TEST_CEILING_BOUNDS` (`constants/load-test.ts`) on write **and** on rehydrate, because the bounds are the engine's crash guards and a build that tightens one must not keep offering a stored ceiling above it. The load dialog turns them into its field ranges via `resolveLoadTestLimits`; nothing else reads them.

**Persisted** to localStorage (via `zustand/persist`), `version: 1` with a
pass-through `migrate`; workspace/session state (open tabs, layout, active
environment) is deliberately excluded from the reset, as is the live chart
window - that one is engine config, so it resets with the engine's settings.

**Nested preferences are completed against their defaults on rehydrate**
(`mergeWithNestedDefaults`). zustand's merge is a shallow top-level spread, so a
stored `editor` / `autoSave` / `notifications` / `loadTestCeilings` object
replaces its defaults whole and a key added after that payload was written
arrives `undefined` - `notifications.maxVisible` feeds `slice(-maxVisible)` in
`toast-store`, and `slice(-undefined)` caps nothing. Adding an object-valued
preference means adding a line to that merge; the store's test enumerates them
rather than trusting the list.

#### `dashboard-store.ts` - Load Test Metrics & State

Manages live load test run state: streaming metrics, final reports, and running aggregates (peak concurrency, SLO breakpoint). Retention is **time-based, not a fixed point count**: `addMetricsBatch` trims ticks older than the user-configurable live window (`liveWindowSeconds`, default 5m, `null` = full run), backstopped by a `maxRetainedTicks` ceiling (default 50,000). Both are kept in sync by the `useLiveChartSettings` hook and drive what the live charts plot. (`app/src/config/metrics.ts` now only holds the SSE commit throttle, `METRICS_UI_THROTTLE_MS`.)

**The window is engine config, not a renderer preference.** It is stored as the engine's `liveReplayWindowMs` entry (milliseconds; `0` = full run), so `useLiveChartSettings` reads it from `useConfigQuery` and writes it with `useUpdateConfigMutation` - there is no localStorage key. The engine needs the same number: it sizes the in-memory SSE tick ring that `GET /runs/:runId/live` replays **from offset 0**, and that replay is what rebuilds these charts when the dashboard attaches or re-attaches mid-run. Two settings would let the retained span and the displayed span disagree, with the engine replaying less than the chart is configured to show. `constants/live-window.ts` owns the option list and the `liveWindowToMs` / `liveWindowFromMs` mapping. The Dashboard picker is its **only** editor: the engine settings list rendered a second one until #586, under a different label and a different save model, and `ENGINE_SETTINGS_EDITED_IN_APP` (`modules/settings/engine-settings-edited-in-app.ts`) is what keeps that row out of it now.

The **tick ceiling** is shared the same way, as `liveMaxRetainedTicks` (default 50,000). It is a memory bound, not a rendering one - `bucketColumns` collapses ticks into `chartBucketSeconds` buckets (0.5s by default) before uPlot sees them, and uPlot draws to canvas, so a full window reaches the screen as a few thousand points however many ticks back it. It also costs nothing at stock settings, since the *window* is what sizes the retained history; it only binds when window / tick-interval exceeds it. `DEFAULT_MAX_RETAINED_TICKS` here and `DEFAULT_MAX_LIVE_TICKS` in the engine are the pre-config defaults and must move together.

Because the value arrives asynchronously, the store seeds `liveWindowSeconds` with the module default rather than reading it synchronously at creation; the hook corrects it once the config query resolves.

**State:**
```typescript
{
  currentRunId: string | null
  mode: "running" | "completed" | "stopped"
  isStreaming: boolean
  currentMetrics: LoadTestMetrics | null
  historicalMetrics: LoadTestMetrics[]  // Trimmed to liveWindowSeconds (cap: maxRetainedTicks)
  monitorSamples: MonitorSample[]       // Server vitals scraped this run (cap: maxRetainedTicks)
  liveWindowSeconds: number | null             // Live retention window; null = full run
  finalReport: RunReport | null
  error: string | null
  activeView: "metrics" | "request-response"
  isStopping: boolean
  loadTestConfig: LoadTestRunConfig | null     // Config snapshot during run
  requestInfo: LoadTestRequestInfo | null      // Request snapshot during run
  peakConcurrency: number                      // Running max (monotonic)
  breakpoint: Breakpoint                       // SLO crossing (latched on first breach)
}
```

**Key Methods:**
```typescript
const {
  startRun, stopRun, setStreaming,
  addMetricsBatch,  // Efficiently fold batch into history and update aggregates
  addMonitorSamples, // Append scraped server vitals, bounded by maxRetainedTicks
  setFinalReport, setError, setActiveView, setStopping,
  setLiveWindowSeconds,  // Update the live retention window (from useLiveChartSettings)
  setMaxRetainedTicks
} = useDashboardStore();
```

The load-test dialog seeds its scrape cadence and bounds its metric list from
the engine's `monitorIntervalMs` / `monitorMaxSeries` settings, through
`useMonitorSettings` - the same read-the-engine's-copy arrangement
`useLiveChartSettings` uses above, and for a sharper reason: this dialog always
sends an explicit `intervalMs`, so a renderer-local default would mean the
setting never applied to a run started here at all.

`monitorSamples` is kept **beside** the ticks rather than merged into them: the
two are sampled by different clocks (the engine's tick cadence and the user's
scrape interval), so they are joined onto one x axis at render time by
`joinMonitorToTimeline` - which is also where a failed scrape becomes a gap in
the line rather than a plateau. The array is empty for a run that configured no
monitor, and that emptiness is what keeps the vitals chart row off the dashboard
entirely. It carries its own copy of the tick ceiling because a scrape can be
configured faster than the tick cadence.

There is deliberately no store-wide `reset`: `startRun` already wipes the series,
the report and the aggregates, and a reset on top of it nulls `currentRunId` -
the dashboard then shows no active test while one streams.

**Non-persisted** (fresh per session).

#### `scenario-run-store.ts` - Live Collection-Run Steps

The live half of a scenario (collection) run's tab. `ScenarioRunService` pushes each `step` SSE event in here and `ScenarioRunView` reads it, so the stream survives navigating away from the tab and back - the same split, for the same reason, as `LoadTestService` and `dashboard-store`.

It holds **one** run. A scenario is sequential and the app starts one at a time, so `startRun` replaces the previous run's steps rather than accumulating; a tab for an older run reads an empty list rather than whatever is streaming now. `addStep` drops an event that arrives with no run registered, because the stream is replayable and a step from a replaced run can still land on a socket that has not finished closing.

**State:**
```typescript
{
  runId: string | null       // The run being streamed, or null
  steps: ScenarioStepRow[]   // Reported so far, in plan order
  isStreaming: boolean
  error: string | null       // A transport failure on the stream
}
```

Steps are folded in by `appendStepEvent` (`modules/history/main/scenario-steps.ts`), which keys on `(iteration, stepIndex)` rather than arrival order: the engine's SSE ring replays from `Last-Event-ID`, so a reconnect re-delivers events already rendered and an append-only list would double every row it re-saw. It returns the same array reference when a replayed event changes nothing, so an idempotent replay does not re-render the list.

Once a run reaches a terminal status its stored `results` rows are the complete record and the view reads those instead. `ScenarioRunService.handleClose` invalidates `runs.detail(runId)` and refetches `runs.report(runId)` through the query cache - the same keys the tab reads, so a bare fetch would leave the pane on the stale copy. It also invalidates `runs.lists()` (the History row still says "running") and `runs.lastCollectionRuns()` (the context bar's Last run section says it too, from its own family, and is not polled at all).

**That report fetch carries `staleTime: 0`, and the feature rides on it.** The tab mounts the moment the run *starts* and asks for the report immediately, when the engine has written no step rows yet - they go to SQLite in one batch at the end - so the cache holds a report with an empty `results[]`, seconds old. Under the hook's own five-minute `RUNS_STALE_TIME_MS` that entry reads as fresh and `fetchQuery` resolves from it without a request, which left the step list on the live rows for the life of the tab and made every step expand into an empty panel, since only a stored row carries the exchange. This is the one fetch in the app that *knows* the data just changed, so it is the one that must not honour the cache. The engine writes the rows, then the summary, then the terminal status, and publishes `complete` after all three, so the refetch cannot race the write it exists to pick up.

There is deliberately no `stopMonitoring` on the service and no `clear` on the store: the stream ends on its own when the engine sends `complete`, and nothing in the app stops a collection run mid-flight yet. Both belong with the stop control that would need them.

**Non-persisted** (fresh per session).

#### `execution-events-store.ts` - Live Streaming-Request Events

The live half of a **streaming design request** (issue #574): `POST /execute` with `stream: true` answers `202 {runId, eventsUrl}` and the upstream's own events arrive over `GET /runs/:id/events`. `modules/request-builder/hooks/useExecutionEvents` pushes each relayed frame in here and the response pane's Events tab reads it, so the rows survive switching to another request tab and back - the same split, and the same reason, as `scenario-run-store` above.

It holds **one** stream: a second Send is what ends the first, so two are not a state the builder can reach. It also holds the **request** the stream belongs to, not only the run - one `RequestBuilderProvider` serves every request tab, so "are these rows mine?" is a question about the request on screen and a run id alone cannot answer it. Both the provider and the viewer select against `requestId`, which is what stops a stream started elsewhere appearing under a request that never streamed.

**State:**
```typescript
{
  requestId: string | null      // Whose Send started this stream
  runId: string | null          // The run the engine created; what a Stop names
  eventsUrl: string | null      // Engine-relative, exactly as the answer gave it
  open: StreamOpen | null       // What the stream connected to (the `open` frame)
  events: StreamEvent[]         // Received so far, oldest first
  totalEvents: number | null    // The engine's own count, from the `complete` frame
  isStreaming: boolean
  endReason: StreamEndReason | null
  error: string | null          // A transport failure on the relay
}
```

**Every write is addressed to a run, and a write for a run the store is not holding is dropped.** Not defensive tidiness: the relay replays its retained ring on connect, so a frame from a stream that has already been replaced can still arrive on a socket that has not finished closing - and those rows landing under the send that replaced it is the worst failure here, because such a timeline looks real.

`totalEvents` is set only from the `complete` frame (falling back to what arrived, so it is never left null once a stream has ended). While the stream runs, the arrived-so-far count is `events.length`; reporting anything else would be a total nothing had counted. It matters because it is **not** the row count once a list has been capped, and the Events tab's truncation disclosure compares the two.

Once the run reaches a terminal status the **stored** trace is the complete record: the provider fetches the report, `restore-response.ts` maps its `events` node onto `ResponseState`, and the tab reads that instead - the two-sources-one-list handoff `ScenarioRunView` makes. What lives here is only ever what arrived on the socket, bounded by the engine's retained ring rather than by anything this side.

**Non-persisted** (fresh per session).

#### `import-modal-store.ts` - Import Modal UI

Simple modal state for the collection import dialog.

**State:**
```typescript
{
  isOpen: boolean
}
```

**Key Methods:**
```typescript
const { isOpen, open, close } = useImportModalStore();
```

#### `toast-store.ts` - Transient Notifications

The queue behind the toasts. It holds *what* to show; the Radix primitive in
`components/ui/toast.tsx` owns *when* - the dismiss timer, pausing on hover,
focus and window blur, swipe, and the open/closed state the exit animation keys
off. There is no `setTimeout` in the store.

**State:**
```typescript
{
  toasts: Toast[]   // { id, title?, message, variant, action?, duration }
}
```

**Key Methods:**
```typescript
const { showToast, dismissToast } = useToastStore();

showToast("Run history cleared", "success");   // string form, still supported
showToast({                                     // returns the toast id
  message: "Couldn't stop the run",
  variant: "error",
  action: { label: "Try again", onClick: retry },
});
```

Variants are `info` | `success` | `warning` | `error`, with base durations of 4s
/ 4s / 6s / 10s from `TIMING.TOAST_DURATION_MS`. `warning` is for a refusal ("A
load test is already running") as distinct from a failure.

**Three of the policies are user preferences** (`notifications` on
`client-settings-store`, shapes in `constants/toast.ts`), applied here on the way
in:

- `minSeverity` - a floor, compared by `passesSeverityFloor`. Below it
  `showToast` returns an id and shows nothing.
- `durationScale` - a **multiplier** over the per-variant duration
  (`scaledDuration`), not a replacement for it, so halving keeps the ratio
  between a confirmation and a failure. `never` becomes `NEVER_DISMISS_MS`
  rather than `Infinity`, which the primitive's `setTimeout` would coerce to 1.
- `maxVisible` - the stack cap, defaulting to `MAX_TOASTS` (4); past it the
  oldest is dropped.

Two more policies live here because the primitive has no opinion on them: an
identical message and variant already on screen is **collapsed rather than
stacked**, and an explicit `duration` from the caller wins over the scale.
Removal is driven by
the primitive's `onOpenChange(false)`, which covers timeout, close button and
swipe alike, so there is one removal path rather than three - but it *closes*
the toast rather than dropping it, and the entry leaves the queue
`TIMING.TOAST_EXIT_MS` later so the exit animation has frames to run in.

**The values are not in the store.** Delays live in `config/timing.ts`
(`TOAST_DURATION_MS`, `TOAST_EXIT_MS`) with every other UI-facing delay in the
app, and the stack cap in `constants/toast.ts` (`MAX_TOASTS`). The store holds
behaviour, not configuration.

See `docs/design-system.md` -> Toasts for the visual tokens.

### Module-Local Stores

Module-local UI stores co-locate in `app/src/modules/<feature>/<feature>-store.ts` and manage feature-specific UI state that should not leak into the global store tree.

#### `modules/collections/collections-store.ts` - Collections Tree Expansion

UI-only: Which collections are expanded/collapsed in the tree.

**State:**
```typescript
{
  expandedCollectionIds: Set<string>
}
```

**Key Methods:**
```typescript
const {
  expandedCollectionIds,
  toggleCollectionExpanded, expandCollection, expandCollections
} = useCollectionsStore();
```

**Every action here has a caller, and expanding is idempotent.** `expandCollection`
(one id) and `expandCollections` (an ancestor chain) both return the *same* Set
when nothing changes, because it is passed down the whole tree and listed in
effect dependencies - a fresh Set for a no-op re-renders every row and re-runs
the reveal effect. That is why the tree calls them instead of hand-rolling
`if (!expanded.has(id)) toggle(id)`, which reads the set it writes and so drags
`expandedCollectionIds` into the dependencies of everything that expands.
`collapseCollection` and `reset` used to live here with no callers at all;
collapsing goes through `toggleCollectionExpanded`.

#### `modules/history/history-store.ts` - History Filter & Sort

UI-only: Search, filter (type/status/pinned), and sort (newest/oldest) for the history tab.

**State:**
```typescript
{
  searchQuery: string
  filterType: "all" | "load" | "design"
  filterStatus: "all" | "pending" | "running" | "completed" | "stopped" | "failed"
  pinnedOnly: boolean
  sortBy: "newest" | "oldest"
}
```

**Helper:** `filterRuns(runs, filters)` applies **type/status filtering and
sorting** to the loaded pages. Search is **not** handled here: `searchQuery` is
debounced into the server-side `q` param (see `useRunsQuery`) so it covers all
runs, not just the pages loaded into the sidebar.

`pinnedOnly` is server-side for the same reason - it drives
`GET /runs?baseline=true`, so a pin older than the loaded pages is still
findable - **and** applied again in `filterRuns`. That second pass is not
redundant: unpinning patches the loaded pages in place rather than refetching
them (see `useSetRunBaselineMutation` below), so the row just unpinned would
otherwise sit in the pinned-only list until the next poll. The param decides
what is fetched; the pass decides what is shown. `false` is never sent: the
engine reads `baseline=false` as "only unpinned runs", so the off state omits
the param entirely.

**Key Methods:**
```typescript
const {
  searchQuery, setSearchQuery,
  filterType, setFilterType,
  filterStatus, setFilterStatus,
  pinnedOnly, setPinnedOnly,
  sortBy, setSortBy,
  resetFilters
} = useHistoryStore();
```

#### `modules/variables/variables-store.ts` - Variables Category Selection

UI-only: Which category (globals/collection/environment) is selected in the variables tree.

**State:**
```typescript
{
  selectedCategory: VariableCategory | null
  // VariableCategory = { type: "globals" } | { type: "collection"; collectionId }
  //                  | { type: "environment"; environmentId }
}
```

**Key Methods:**
```typescript
const { selectedCategory, setSelectedCategory, reset } = useVariablesStore();
```

#### `modules/settings/settings-store.ts` - Settings Category Selection

UI-only: Which settings category (e.g., "ui") is selected in the sidebar.

**State:**
```typescript
{
  selectedCategory: SettingsCategory | null
}
```

**Key Methods:**
```typescript
const { selectedCategory, setSelectedCategory } = useSettingsStore();
```

#### `lib/graphql/explorer-store.ts` - GraphQL Schema Explorer View

UI-only, in memory: whether the schema explorer pane is open, and per schema
identity the search text, the expanded row ids, the scroll position and whether
rows show their full description or one clipped line.

**State:**
```typescript
{
  open: boolean,
  byKey: Record<
    string,
    { search: string; expanded: string[]; scrollTop: number; showDescriptions: boolean }
  >,
  lru: string[]
}
```

**Key Methods:**
```typescript
const { open, setOpen, view, setSearch, toggleExpanded, setScrollTop, toggleDescriptions } =
  useExplorerStore();
```

`showDescriptions` is per schema like everything else here: how much
documentation a user wants on screen is a property of the schema being read, and
an endpoint that documents nothing has nothing to answer for.

**A store rather than component state, because the pane is unmounted for no
reason the user did.** Radix tears the whole Body tab down on every glance at
Headers or Auth - the same unmount the [body drafts](#requestbuildercontext---body-drafts)
exist for - and a component-state explorer comes back collapsed to its roots
with an empty search box.

**Keyed by schema identity**, using the schema cache's own `schemaCacheKey`, so
two requests against one endpoint share the tree they have opened and the same
URL reached with different credentials does not. Deliberately not persisted and
capped at `EXPLORER_VIEW_MAX_ENTRIES` (8, matching the schema cache): an
expansion set is a description of a schema that may not exist next launch.

#### `lib/graphql/reveal-store.ts` - GraphQL Outline Click-to-Scroll

UI-only, in memory: one slot holding the operation the context bar's GraphQL
outline asked the query editor to scroll to, until something serves it.

**State:**
```typescript
{
  pending: { requestId: string | null; name: string | null; index: number } | null
}
```

**Key Methods:**
```typescript
const { pending, revealOperation, clearReveal } = useRevealStore();
```

**A store because the two ends cannot see each other.** The outline lives in the
context bar, outside `RequestBuilderProvider`; the Monaco instance lives inside
`GraphQLBody` and stays there, the way the insert machinery applies its edits
in-component rather than handing the editor out. What crosses the boundary is a
request to reveal, not an editor.

**Consume-and-clear**, for the reason the insertion effect records: a command
left in the slot is replayed on the next render and the next remount, and Radix
remounts the Body tab on every glance at Headers. `GraphQLBody` clears it once
served **and** when it cannot serve it (the operation was renamed away, which it
says out loud); the provider clears one naming another request or a request
whose body is no longer GraphQL, since nothing under it can ever serve those.
The provider's other half is bringing the Body tab forward - the editor does not
exist while another tab is on screen.

**A command names its request** for the reason the
[body drafts](#requestbuildercontext---body-drafts) do: only one request builder
is mounted at a time, so a mismatch takes a click and a tab switch in the same
tick, and the cost of not carrying the id is another request's editor jumping to
a line number that means nothing there.

## TanStack Query (Server State)

TanStack Query manages server state with automatic caching, refetching, and synchronization. It is the source of truth for collections, requests, environments, globals, and runs.

### Query Hooks

Located in `app/src/queries/`, one file per resource family, all re-exported
from `app/src/queries/index.ts`, which is what callers import from. The key
factory lives beside them in `app/src/queries/keys.ts`. A couple of hooks with a
single consumer are imported from their file directly (`useRunTimeSeriesQuery`
from `@/queries/runs`); everything with more than one is in the barrel.

#### Collections & Requests

- **`useCollectionsQuery()`** - Fetch all collections (there is no
  single-collection query: a collection is read out of this list)
- **`useRequestsQuery(collectionId)`** - Fetch requests in a collection
- **`useMultipleCollectionRequests(collectionIds)`** - The same list for several
  collections at once, as parallel queries. Its `requestsByCollection` map is
  **referentially stable** while the underlying results are unchanged (built in
  `useQueries`' `combine`, which TanStack memoises only for a `combine` of
  stable identity - hence the `useCallback`). Callers list it in effect
  dependencies; when it was rebuilt on every call, the collection tree's reveal
  effect (`useRevealActiveSelection`) re-ran on every render and re-expanded a
  collection the user had just collapsed
- **`useRequestQuery(requestId)`** / **`requestDetailOptions(requestId)`** - One
  request by id (`GET /requests/:id`), used by a restored request tab and by a
  design-run copy on cold start. Only an `ApiError` with `statusCode === 404`
  becomes **`RequestNotFoundError`** (test it with `isRequestNotFound`); a 5xx or
  an unreachable engine is rethrown untouched, because a transport failure must
  not read as "this request was deleted"
- **`useCollectionAncestors(collectionId)`** - The collection's ancestor chain
  including itself, root first, derived from the collections list rather than
  fetched
- **`usePrefetchCollectionsAndRequests()`** - Warm-cache pass over every
  collection's requests at startup

**Sorting:** every tree list - roots, a collection's children, a collection's
requests - sorts with the single exported `compareTreeOrder` (`types/domain.ts`):
`order`, then `createdAt`, then `id` byte-wise. There were two comparators with
two different tie rules and neither matched the engine's, so "run this folder"
could execute in an order the sidebar had never shown. The rule is pinned to the
engine's SQL by `engine/tests/fixtures/tree-order-conformance.json`, read by
`types/tree-order.conformance.test.ts` and by the engine's `tree_order_test.cpp`
- change one side and the other suite fails.

That rule orders **one block**. A folder's sub-collections and its requests are
two separately ordered blocks, so their `order` values can collide, and where the
blocks sit relative to each other is the render's rule: `CollectionItem` puts
every subfolder above every request, at every depth
(`CollectionTree.folders-first.test.tsx`). A recursive collection run has to
execute in that same sequence - each subfolder's whole subtree, then the folder's
own requests - which is pinned across the render and the engine's plan by
`engine/tests/fixtures/recursive-run-order-conformance.json`, read by
`modules/collections/CollectionTree.run-order.conformance.test.tsx` and by the
engine's `scenario_plan_test.cpp` (issue #431).

**Mutations:**
- **`useCreateCollectionMutation()`** - Create collection
- **`useUpdateCollectionMutation()`** - Update collection (with cache update)
- **`useDeleteCollectionMutation()`** - Soft-delete a collection into the trash
  rather than removing it (issue #988); invalidates coarsely, see below, and
  also invalidates the trash list so the Trash view picks it up
- **`useCreateRequestMutation()`** - Create request
- **`useUpdateRequestMutation()`** - Update request (invalidates only the lists
  that can have changed, see below)
- **`useDeleteRequestMutation()`** - Soft-delete a request into the trash (also
  clears the response, and invalidates the trash list)
- **`useReorderMutation()`** - Reposition collections and requests through
  `POST /reorder` in one transaction, optimistically (see below)
- **`useImportMutation()`** (`queries/import.ts`) - Apply a parsed import through
  `POST /import/apply` in one transaction

**Reordering (`useReorderMutation`)** is the one mutation that writes its caches
three times, because a drag is only believable if the row is where the pointer
left it before the write returns:

- `onMutate` snapshots every key the plan can touch and *draws the plan* into the
  caches - the same two steps the engine performs, normalize each named scope to
  `0..n-1` in display order, then position each move. A cross-collection move
  crosses list caches and updates `requests.detail` (which carries
  `staleTime: Infinity`, so a stale `collectionId` there would outlive every
  refetch).
- `onSuccess` re-applies the rows the engine actually wrote, which the response
  carries. They are normally what was drawn, but a normalization is authoritative
  from the engine, so the tree settles on real positions rather than a guess.
- `onError` restores the snapshots wholesale and reports through
  `useSaveStore.failSave` - the one channel every save failure reaches the Dock
  and the toast through. The mutation owns this rather than its caller, so the
  gesture layer cannot forget it.
- `onSettled` invalidates the affected keys **once** - the collections list only
  if a collection moved, and only the request lists the plan named.

Every write goes through `setQueryData` with a fresh array, never a mutation in
place: the map `useMultipleCollectionRequests` builds is compared by reference by
the reveal effect, so an in-place edit would move a row on screen that the tree
never notices. The plan itself comes from
`modules/collections/reorder-math.ts` - a pure module, node-tested, that turns
sibling lists and a drop index into the minimal set of rows to rewrite.

#### Trash

The read side of the same soft delete (issue #989): `useDeleteCollectionMutation`
and `useDeleteRequestMutation` stamp a row rather than removing it, and these
are how the app sees what got stamped (`queries/trash.ts`).

- **`useTrashQuery()`** - Every deleted root, newest first (`GET /trash`). No
  `staleTime`: the list changes only through the two mutations below, the two
  delete mutations above, and the startup retention purge, so the default is
  already the cheapest correct answer.
- **`useRestoreTrashMutation()`** - Put one deleted root back
  (`POST /trash/:id/restore`). Invalidates `trash.all`, `collections.all`,
  `requests.all` and `prefetch.allRequests()` - the same coarse invalidation
  `useDeleteCollectionMutation` does, and for the same reason (see the cascade
  delete note below).
- **`usePurgeTrashMutation()`** - Destroy one deleted root for good
  (`DELETE /trash/:id`). Invalidates only `trash.all`: every other cache
  already stopped serving these rows when they were stamped, so purging them
  changes nothing a live read can see.

#### Environments & Variables

- **`useEnvironmentsQuery()`** - Fetch all environments
- **`useGlobalsQuery()`** - Fetch global variables
- **`useCookiesQuery()`** / **`useClearCookiesMutation()`** (`queries/cookies.ts`) -
  The engine's cookie jars, one per environment, read and cleared by
  `CookiesCard` in Settings. The mutation invalidates rather than patching the
  cache: a clear that raced a request in flight would otherwise leave the panel
  claiming an empty jar the engine has already refilled
- **`useClientCertificatesQuery()`** and the create / update / delete mutations
  (`queries/client-certificates.ts`) - the engine's host-to-certificate registry
  for mTLS endpoints (issue #707), read and edited by `ClientCertificatesCard`
  in Settings > Network & connectivity. The mutations invalidate rather than
  patching: the engine refuses a second entry for a host+port pair already
  taken, so the list is the authority on what a new entry may claim

**Mutations:**
- **`useCreateEnvironmentMutation()`**
- **`useUpdateEnvironmentMutation()`**
- **`useSetActiveEnvironmentMutation()`** - The only writer of the active
  environment; PUTs `isActive` and mirrors it into `session-store`, rolling the
  store back if the engine refuses
- **`useDeleteEnvironmentMutation()`**
- **`useUpdateGlobalsMutation()`**

#### Runs & History

- **`useRunsQuery(q?)`** - Run history as an **infinite query** over the
  paginated `GET /runs` `{data, pagination}` envelope, newest first. Mirrors
  `useRunTimeSeriesQuery`'s `getNextPageParam` on the same envelope shape;
  `fetchNextPage` pages older runs in on demand. `q` is the optional
  server-side search.
  - **Polling is gated to the unpaged state** (`runsPollInterval`): 5s while
    only page 1 is loaded, **off** once the user has paged older runs in.
    Refetching an infinite query re-fetches *every* loaded page in sequence, so
    a user ten pages deep drove ~10 engine requests per tick. Only page 1 can
    gain rows (`start_time DESC`) anyway; a paged list refreshes on the next
    mutation or invalidation instead of on a timer.
  - **`flattenRunPages(data)`** - flatten the pages into a de-duped `Run[]`
    (dedupe by id guards the momentary double-row a head insertion can cause
    across two refetched pages). **`runsTotal(data)`** - the server's total from
    the first page.
- **`useAllRunsQuery()`** - Every run (all pages) as a flat list, for callers
  that need the whole set rather than a polled page (Settings' count + clear).
  Not polled.
- **`useLastDesignRunQuery(requestId)`** - The most recent completed design run
  for a request, in **one** filtered call
  (`?requestId=&type=design&status=completed&limit=1`) - the server sorts
  `start_time DESC`, so its single row is the answer. No client-side
  download-and-filter. It caches a **plain `RunListResponse`**, so it has its
  own key family (`queryKeys.runs.lastDesign(requestId)`) and deliberately does
  **not** sit under `runs.lists()`: `RequestBuilderProvider` mounts it for every
  open request tab, and the delete-run patch walks that prefix as
  `InfiniteData`. Keeping the two shapes apart at the root is the rule - a
  prefix patch must never meet a cache shape it did not write. Under the
  `lastDesigns()` prefix, like the three families below it, so a delete, a
  cleared history or an MCP `run` event reaches it without knowing which
  request it belonged to (#776): a run id gives no way back to one, and until
  the prefix existed a deleted design run went on being restored into the tab
  that had it open.
- **`useRecentDesignRunsQuery(requestId)`** - The last `RECENT_DESIGN_RUN_LIMIT`
  (5) design runs of a request, newest first, behind the context bar's **Recent
  sends** section. One filtered call (`?requestId=&type=design&limit=5`) and
  **no report fetch**: each row carries its own `resultSummary` (`statusCode` +
  `latencyMs`) from the engine, and the report path would load and JSON-parse
  every result's `trace_data`, per row. Deliberately **unfiltered by status**,
  unlike `useLastDesignRunQuery` - `status` takes one value, so filtering to
  `completed` would hide every failed send, which is most of what a trend is
  read for. Own key family (`queryKeys.runs.recentDesign(requestId)`) under the
  `recentDesigns()` prefix, outside `runs.lists()`, for the same shape reason as
  `lastDesign`. Not polled: the builder's send path, `DesignRunView`'s replay,
  the MCP `run` event, `useDeleteRunMutation` and `useInvalidateRuns` (Settings'
  *Clear run history*) each invalidate it, and a new run-writing path has to as
  well or the section keeps showing the sends from before it.
- **`useLastCollectionRunQuery(collectionId)`** - The most recent run of one
  collection, behind the context bar's **Last run** section. One filtered call
  (`?collectionId=&limit=1`) over the engine's `collectionId` filter, which
  matches a scenario snapshot's own `scenario.collectionId` as JSON rather than
  its text - the lookup that did not exist, which is why the section was
  deferred twice (#377 → PR #394 → PR #400 → #422). Unfiltered by status for the
  same reason `useRecentDesignRunsQuery` is: a failed run is the one worth
  surfacing. Own key family (`queryKeys.runs.lastCollectionRun(collectionId)`)
  under the `lastCollectionRuns()` prefix, outside `runs.lists()`, for the third
  time and the same shape reason. Invalidated by
  `useStartScenarioRunMutation` (the new run *is* the last run),
  `useDeleteRunMutation` and `useInvalidateRuns`.
- **`useRunQuery(runId)`** / **`runDetailOptions(runId)`** - Fetch a single run
  (full `configSnapshot`). Same 404 contract as `requestDetailOptions`: only an
  `ApiError` with `statusCode === 404` becomes **`RunNotFoundError`** (test it
  with `isRunNotFound`, never by message), and that error is **never retried** -
  a run tab is persisted and outlives its run, so a deleted run used to retry
  forever behind a "Try again" that could not work. Everything else - a 5xx, an
  unreachable engine - is rethrown untouched and keeps the default retry budget.
  `HistoryDetail` renders the two cases differently: "this run no longer exists"
  with **Close tab**, versus "couldn't load this run" with **Try again**.
- **`useRunReportQuery(runId)`** - Fetch final report for a run. Also written by
  `LoadTestService` at stream end via `queryClient.fetchQuery`, so opening the
  run in History reads the cached copy rather than re-fetching a report that
  cannot change.

- **`useRunTimeSeriesQuery(runId)`** (`@/queries/runs`) - The stored per-tick
  series behind the History charts, as an infinite query over the same
  `{data, pagination}` envelope. Historical data cannot change, so
  `staleTime: Infinity`.

**Mutations:**
- **Stopping a run is not a mutation hook.** It is
  `useEngine().stopLoadTest(runId)`, which calls `apiService.stopRun` and
  returns a boolean rather than throwing - the dashboard's Stop button reports
  the refusal itself.
- **`useDeleteRunMutation()`** - Delete a run. Patches every infinite-list cache
  variant in place (drops the row, decrements the mirrored `total`) plus the
  all-runs cache, and evicts the run's report. The list updater shape-guards
  (`!Array.isArray(old.pages)`) as a belt to `lastDesign`'s braces. The
  `recentDesigns()` and `lastCollectionRuns()` families are **invalidated rather
  than patched**: a deleted run gives no way back to the request or collection
  their sections are keyed by, and refetching a few rows beats carrying a
  run-to-owner map to patch them.

**Deleting a run closes its tabs.** Both delete flows - `HistoryList`'s row
delete and Settings' *Clear run history* - call
`closeTabsForEntities(ids, "run")` for the runs the engine actually accepted (a
409'd run keeps its tab, because the run is still there). Tabs are persisted, so
a run tab left open after its run is gone is not merely stale: it rehydrates
into a pane that can never load on every restart.

#### Engine Health, Config & OAuth

- **`useHealthQuery()`** - Health check, polled every
  `TIMING.HEALTH_CHECK_INTERVAL_MS`; it is what sets `isEngineConnected` /
  `engineError` on `engine-store`, so the connection indicator follows it
- **`useConfigQuery()`** / **`useUpdateConfigMutation()`** - Engine configuration
  (`QUERY_CACHE.CONFIG_STALE_TIME_MS`); also the home of the live chart window,
  which is engine config rather than a renderer preference
- **`useScriptCompletionsQuery()`** / **`useScriptTypeDefinitionsQuery()`** - the
  `pm.*` completion list and the engine-generated `.d.ts` behind Monaco's hover
  text and diagnostics. Both derive from one engine-side table that changes only
  with the engine binary, so both take
  `QUERY_CACHE.SCRIPT_COMPLETIONS_STALE_TIME_MS` and the same gc time; the type
  definitions also cap retries at `SCRIPT_COMPLETIONS_RETRY`, since losing them
  costs hover text rather than the editor
- **`useOAuth2TokenStatusQuery(cacheKey)`**,
  **`useFetchOAuth2TokenMutation()`**, **`useClearOAuth2TokenMutation()`** - the
  engine-side OAuth 2.0 token cache
- **`queryKeys.compose.forRequest(requestId, environmentId)`** - `POST /compose`
  for a stored request, behind an inline `useQuery` in the context bar's Code
  section. Keyed by environment as well as request, because the same request
  composes differently per environment and one key for both would serve the
  wrong snippet after a switch. `staleTime: Infinity` with an explicit
  recompose: the section is only mounted while expanded, so this is the "compose
  on expand, not per keystroke" rule

### Query Keys & Cache Invalidation

Centralized in `app/src/queries/keys.ts`, using TanStack Query's hierarchical key
factory pattern. **Copy the shapes from that file rather than hand-writing a
key** - a key that differs by one segment is not an error, it is a silent cache
miss that presents as a data bug:

```typescript
// app/src/queries/keys.ts (abridged)
collections: {
  all: ["collections"],                                   // a constant, not a call
  lists: () => ["collections", "list"],
  list: () => ["collections", "list"],
  details: () => ["collections", "detail"],
  detail: (id) => ["collections", "detail", id],
},
requests: {
  all: ["requests"],
  lists: () => ["requests", "list"],
  listByCollection: (collectionId) => ["requests", "list", { collectionId }],
  details: () => ["requests", "detail"],
  detail: (id) => ["requests", "detail", id],
  examples: (id) => ["requests", "detail", id, "examples"],  // saved example responses (#481)
},
trash: {
  all: ["trash"],
  list: () => ["trash", "list"],   // no per-entry detail cache - the list is the only read
},
runs: {
  all: ["runs"],
  lists: () => ["runs", "list"],
  list: (filters = {}) => ["runs", "list", filters],      // keyed by its server-side filters (q, baseline)
  lastDesigns: () => ["runs", "lastDesign"],               // prefix: invalidate every request's last run
  lastDesign: (requestId) => ["runs", "lastDesign", requestId],
  recentDesigns: () => ["runs", "recentDesign"],           // prefix: invalidate every request's list
  recentDesign: (requestId) => ["runs", "recentDesign", requestId],
  lastCollectionRuns: () => ["runs", "lastCollectionRun"], // prefix: invalidate every collection's row
  lastCollectionRun: (collectionId) => ["runs", "lastCollectionRun", collectionId],
  baselines: () => ["runs", "baseline"],                  // prefix: invalidate every request's pin
  baseline: (requestId) => ["runs", "baseline", requestId],
  allRuns: () => ["runs", "allRuns"],
  detail: (id) => ["runs", "detail", id],
  report: (id) => ["runs", "report", id],
  timeSeries: (id) => ["runs", "timeSeries", id],
  monitorSeries: (id) => ["runs", "monitorSeries", id],   // scraped server vitals, when the run had a monitor
  samples: (id) => ["runs", "samples", id],               // captured response bodies, fetched lazily
},
// environments mirrors collections; globals / cookies / health / config /
// scriptCompletions / scriptTypes / oauth / prefetch each own a root.
```

The `lists()` / `details()` levels exist to be invalidated as prefixes; what a
query is keyed on is `list()` / `detail(id)`. `requests.examples(id)` sits
*under* `detail(id)` rather than beside it, because examples are owned by the
request: invalidating one request's subtree drops its examples with it, which is
what a request delete needs. `runs.lastDesign`,
`runs.recentDesign`, `runs.lastCollectionRun` and `runs.baseline` sit under
`runs.all` but deliberately **not** under `runs.lists()` - see below.

`runs.baseline(requestId)` caches the run pinned as that request's baseline
(`GET /runs?baseline=true&requestId=&limit=1`), which the history report's
vs-baseline strip reads. Pinning, unpinning and deleting a run all **invalidate
the `baselines()` prefix** rather than patching it: the pin moves, and a run id
gives no way back to the request whose baseline it was - a run of an unsaved
request has no `requestId` at all. The pin *flag* on the loaded list rows is
patched in place from the mutation's response, the same way a delete patches
them, because the sidebar polls only its first page and a refetch would leave a
pin invisible on any page the user had scrolled to.

`specs.detail(id)` and `specs.meta(id)` are the same document under two keys
(issue #712): the full read carries `content` and both extracted indexes, the
meta read describes the row and nothing else. They are kept apart rather than
merged so a cached description can never satisfy a reader that needs the text -
and holding one row twice is safe here precisely because a document is immutable,
which is also why both carry `staleTime: Infinity`. The Spec tab's card reads
meta; the import dialog's bound-spec match and the Sync section's Check read the
full document, each on the action that needs it. Export reads neither since it
moved engine-side (issue #855) - `specs.export(collectionId, format, opened)`
holds the finished document instead, keyed by format because the dialog toggles
between two serializations of one answer, and by the moment the dialog mounted
because a *collection* changes under its id in a way a document never does:
that is what makes it fresh on every open and cached across a toggle, which
neither `staleTime` alone can say.

`specs.match(collectionId, fingerprint)` is the third of that family and the one
that names no document (issue #761): the pairing of a collection's requests
against a picked document's operations, answered by `POST /specs/match` since
the matcher moved engine-side. There is no id to key it by - the document has
not been stored, because the tab asks before the user commits to the bind - so
the key carries a fingerprint of **both** inputs, exactly the fields the matcher
reads off them (a request's id, method and URL; an operation's identity). That
is what makes its `staleTime: Infinity` honest: an answer cannot go stale while
both inputs are pinned in its key, and either of them changing is a different
key rather than a stale entry under this one.

**Automatic Invalidation:**
- Mutations automatically invalidate related queries (e.g., creating a request invalidates the collection's request list)
- Some mutations use optimistic updates and cache updates for instant UI feedback
- **A cascade delete invalidates coarsely, on purpose.** Deleting a collection
  deletes its descendant collections and all their requests *engine-side*, and
  which rows those are is engine-side knowledge - a client that re-derives the
  subtree to patch caches surgically will drift from the engine's definition of
  "descendant". So `useDeleteCollectionMutation` invalidates
  `collections.all` + `requests.all` wholesale. `requests.detail` entries carry
  `staleTime: Infinity`, so without this a deleted request stays fresh forever
  and keeps feeding restored tabs. `useRestoreTrashMutation` invalidates the
  same two families for the same reason, in the other direction: which rows a
  restore brought back is just as much engine-side knowledge - the cohort is
  defined by a timestamp the client never sees - so it takes the same wholesale
  invalidation rather than a client guess at which requests came back with a
  restored collection.
- **A single-request update invalidates narrowly, for the same reason.** Which
  lists a request write can affect *is* client-side knowledge: the request's own
  collection, plus the one it left if the write was a move. So
  `useUpdateRequestMutation` invalidates `requests.listByCollection(id)` per
  affected collection rather than `requests.lists()`. It used to refetch every
  collection's list on any rename, which a reorder (a run of sibling PUTs) turns
  into one full-tree refetch per row. The source collection of a move is read
  from the `requests.detail` cache, which still holds the pre-update row at that
  point - the response carries only the new owner.
- **The warm-cache prefetch is a query too.** `usePrefetchCollectionsAndRequests`
  is keyed as `queryKeys.prefetch.allRequests()` rather than an inline key, so
  creating a collection can invalidate it - it succeeds once at startup and
  would otherwise never re-run for a collection created mid-session.

**Writes from outside the renderer: `mcp:data-changed`.** An MCP tool call
mutates the engine from the Electron **main** process, so no mutation runs here
and no query notices - and with `refetchOnWindowFocus: false` (below) nothing
ever catches up on its own. A request an agent created stayed invisible in the
collection tree until some unrelated renderer mutation happened to invalidate
the lists. The main process now sends one event per data family a successful
call touched; `useMcpDataInvalidation()` (registered once, in `App.tsx`) maps it
to keys through `lib/mcp-invalidation.ts`:

| Entity | Invalidates | Why that key |
|--------|-------------|--------------|
| `collection` | `collections.all`, `requests.all` | A `delete_collection` cascades through descendants and their requests, and which rows those were is engine-side knowledge - the same reason `useDeleteCollectionMutation` invalidates coarsely |
| `request` | `requests.listByCollection(collectionId)`, or `requests.lists()` when the call named no collection, plus `requests.detail(requestId)` when the call named one row | The same narrowing `useUpdateRequestMutation` does; without a named owner the owner is unknowable here. The detail key is for `update_request` / `delete_request`: it is `staleTime: Infinity`, so a restored tab would otherwise keep serving the copy it read on open |
| `environment` | `environments.all`, `globals.all`, `compose.all` | Variables are read through the detail cache as well as the list; `POST /compose` substitutes those same variables, and nothing refetches a composition on its own. `globals.all` rides along because `update_globals` (#758) declares this family - same resolution order, same blob shape, and an entity of its own would have had exactly one reader |
| `run` | `runs.lists()`, `runs.allRuns()`, `runs.baselines()`, `runs.recentDesigns()`, `runs.lastCollectionRuns()`, `runs.lastDesigns()` - and a **removal** of `runs.detail/report/samples/timeSeries/monitorSeries` for a named `runId` | The history list polls, but Settings' count, the vs-baseline strip, Recent sends, Last run and every open tab's last design run do not. The four prefixes rather than per-row keys because a run id gives no way back to the request or collection it belonged to - the same trade `useDeleteRunMutation` makes |
| `cookie` | `cookies.all` | One key for every jar - the engine reports them together |
| `config` | `config.all` | |
| `service` | `inbox.list()`, `mockServer.list()`, `mockIssuer.list()`, plus a **removal** of `inbox.captures(inboxId)` for a named inbox and of `mockServer.routes(mockId)` for a named mock | The drawer and the Dock's count poll, so the lists are about immediacy; the captures cannot be invalidated, because `useInboxCapturesQuery` merges its fetched page into the cache and would union back the rows a `clear_inbox_captures` just destroyed, and a stopped mock's route table has no id left to refetch from |
| `oauth` | `oauth.all` | The whole prefix, not the one key: `useOAuth2TokenStatusQuery` is keyed per cache key, and the key a `fetch_oauth2_token` writes under is derived engine-side and appears only in the answer, so the event carries no hint to narrow by. The query polls at 30s on its own, so this is immediacy - an agent that clears a token must not leave the row saying it is valid |

The event carries no engine data, only which family went stale, so a row still
reaches the UI by exactly one path: the query layer. Per-run reports and time
series are still never invalidated *wholesale* - a new run cannot have changed
an existing run's report, and those are the expensive fetches in the family.
They are dropped only for the one run a call named: `stop_run`,
`set_run_baseline` and `delete_run` each take a `runId`, and the event carries
it as a third scope hint. Removal rather than invalidation, because `samples`
and both series are `staleTime: Infinity` - a deleted run would otherwise go on
rendering under an open History tab until its entry was garbage collected.
`runs.detail` goes with them so the pane refetches, takes its 404 and shows
`HistoryDetail`'s "This run no longer exists" state instead of a run the sidebar
no longer lists. The hint says *which* run changed, not *how*, so a `set_run_baseline`
costs an open detail pane one refetch of data it already had; a stale answer is
a lie and a refetch is a wait. `runs.lastDesigns()` is taken at its prefix and
never per request (#776): `delete_run` and `set_run_baseline` name a `runId` and
no request, so the narrow key could not reach the tab whose run went away, and
the cost of the prefix is that a `run_request` refetches one filtered row per
*mounted* tab instead of one. The `service` family (issues #756, #757) takes the
same shape one level down, with two scope hints instead of one. `inboxId`: a
named inbox has its capture list *removed* rather than invalidated for a reason
the run family does not have - three writers share that one cache entry (the
fetch, the load-more pages and the live SSE stream), so every write to it is a
union by capture id, and a refetch into a cache still holding cleared rows puts
them straight back. The app's own clear mutation writes an empty page first for
exactly this; from the main process the equivalent is to drop the entry.
`mockId`: a named mock has its route table removed for the mirror reason - the
table is a start-time snapshot held at `staleTime: Infinity`, so an invalidation
would not refetch it, and after a `stop_mock_server` there is nothing to refetch
from, since a mock's record dies with its listener. Both are what
`useDeleteInboxMutation` and `useStopMockServerMutation` already do app-side.
All three lists are invalidated on every `service` event rather than one per
kind, because the entity is deliberately one family: the drawer and the Dock's
count ask "what is listening", not "which kind".
The entity list is duplicated across the process boundary
(`MCP_DATA_ENTITIES` in `electron/mcp/tools.ts`, `McpDataEntity` in
`types/domain.ts`) because production code under `electron/` cannot import from
`app/src`; `data-changed.conformance.test.ts` is what keeps the copies equal,
and the map above is a `Record` over the union so a new family fails to compile
until it names a reader. The emitting side is documented in
[`docs/engine/mcp.md`](../engine/mcp.md).

**Retry policy:** the shared default is `shouldRetryQuery` (`lib/query-client.ts`),
not a bare count. A 4xx from the engine is a verdict, not a hiccup - a 404 for a
deleted row answers identically every time, so retrying it only delays the error
the caller is waiting on. 4xx is never retried; everything else (5xx, timeout,
unreachable engine - which `http-client.ts` throws as a plain `Error`, not an
`ApiError`) keeps the `DEFAULT_QUERY_RETRY` budget.

**Cache policy lives in `config/cache.ts` (`QUERY_CACHE`), not in the call
sites.** Name the constant when you need a duration; restating the number here
is how this section drifted before. The current shape:

| Query | Policy |
|-------|--------|
| Collections, requests lists, environments, globals, runs list | `DEFAULT_STALE_TIME_MS` (30s) via the shared client |
| Request detail (`requestDetailOptions`) | `staleTime: Infinity` - a restored tab reads it once and mutations invalidate it |
| Run detail, run report | `RUNS_STALE_TIME_MS` (5m); completed runs are immutable |
| Run time series | `staleTime: Infinity`, `RUNS_GC_TIME_MS` (30m) |
| Engine config | `CONFIG_STALE_TIME_MS` (1m) |
| Script completions | `SCRIPT_COMPLETIONS_STALE_TIME_MS` (1h), same gc time |
| Health | `staleTime: 0`, refetched every `TIMING.HEALTH_CHECK_INTERVAL_MS` (30s) |

Polling intervals are separate from staleness: the runs list polls every 5s
**only while unpaged** (`runsPollInterval`), health polls on
`TIMING.HEALTH_CHECK_INTERVAL_MS`, and the shared client sets
`refetchOnWindowFocus: false` - a desktop app that refetched everything on focus
would fight the editor the user just came back to.

## Custom Hooks

### `useEngine()` - Compose, Execute, Stop

Wraps the three engine calls that are not queries, with `isExecuting` / `error`
for the caller to render.

**API:**
```typescript
const {
  composeRequest: (params: ComposeRequestRequest) => Promise<ComposedRequest>
  executeRequest: (params: ExecuteRequestRequest, environmentId?: string) => Promise<SanityResult | null>
  stopLoadTest: (runId: string) => Promise<boolean>
  isExecuting: boolean
  error: string | null
} = useEngine();
```

- **`composeRequest`** is `POST /compose` - the engine resolves `{{variables}}`
  and `inherit` auth and hands back the execute-ready payload (issue #226). It
  **throws** on failure; the caller surfaces it like an execute failure.
- **`executeRequest`** takes an *already composed* payload. It never throws:
  a failure comes back as a `SanityResult` with `status: 0` and an
  `errorCode`, because the response pane renders the failure the same way it
  renders a response.
- **`stopLoadTest`** returns `false` rather than throwing when the engine
  refuses.
- **Starting a load test is not here.** The request builder composes, then calls
  `apiService.startLoadTest()` (`POST /runs`), `useDashboardStore().startRun()`
  and `loadTestService.startMonitoring()` in that order, at one call site -
  registering the run before attaching the stream is what keeps the dashboard
  from showing a stream with no run behind it.

### Live Metrics Streaming - `loadTestService` + `sseClient`

There is **no React hook for the metrics stream**, on purpose. The stream has to
outlive whichever view is mounted (navigate away from the dashboard mid-run and
the run keeps streaming), so it is a module singleton:
`services/load-test-service.ts` holds the state machine and
`services/sse-client.ts` the `EventSource`.

```typescript
import { loadTestService } from "@/services/load-test-service";

loadTestService.startMonitoring(runId);  // after useDashboardStore().startRun(...)
loadTestService.stopMonitoring();
```

- Connects to `GET /runs/:runId/live`, a **replayable** tick topic read from
  offset 0 - so attaching, or re-attaching from History mid-run, rebuilds the
  charts rather than starting blank.
- Every tick is buffered; commits into `useDashboardStore().addMetricsBatch()`
  are throttled to `METRICS_UI_THROTTLE_MS` so `historicalMetrics` keeps the
  full 10 Hz signal while renders stay bounded.
- The engine sends an explicit `complete` event, so a `CLOSED` readyState is a
  genuine failure. **There is no custom reconnect**: `EventSource` cannot set
  `Last-Event-ID` on a fresh connection, so a manual reconnect would replay the
  whole topic and duplicate every tick already plotted. The browser's own
  intra-connection retry does carry it and is left alone; once the browser gives
  up, recovery is converging on `GET /runs/:id/report`, which the service does in
  its close handler.

### `useVariableResolver()` - Variable Resolution

Resolves `{{variableName}}` patterns in strings and objects using environment, collection, and global variables.

**API:**
```typescript
const {
  resolveString: (input: string) => string
  resolveObject: <T>(obj: T) => T
  getVariable: (name: string) => ResolvedVariable | null
  getAllVariables: () => Record<string, ResolvedVariable>
  getVariableOrigins: (name: string) => VariableOrigin[]
} = useVariableResolver({ collectionId?: string; boundRow?: DataFileRow });

// resolveString takes an optional per-call row (issue #1074), for the one
// caller that resolves for several requests at once - the tab strip.
resolveString(input: string, row?: DataFileRow): string
```

**Resolution Priority (highest to lowest):**
1. Bound data row (bare column names) - only while `boundRow` is passed and a
   row is actually picked (issue #1062)
2. Environment variables
3. Collection variables
4. Global variables

Collection scope comes from the `collectionId` option and nowhere else - a
caller that passes none resolves against globals + environment. See
`docs/app/variable-resolution.md` for why the session-store fallback was
removed.

`boundRow` is optional and additive: without it `resolveString` /
`resolveObject` resolve exactly as before (composition only, both a bound
column and `{{data.column}}` deferred). With it, they resolve through
`resolveTemplateWithRow` instead, so a bare bound column and `{{data.column}}`
both read the row - the request builder's provider is the one caller that
passes it, deriving it from the picked-row index. See
`docs/app/variable-resolution.md` for the tier and its rules.

`resolveString`'s second argument is the same row named per call instead of per
hook. It exists for `useTabDescriptors`, which labels every open tab from a
single resolver and therefore cannot name one row for the whole of it; it reads
the row out of `useBoundRowStore` for the tab it is labelling. Both spellings
render a row's cells through the same helper, so the two cannot disagree.

**The environment is the one scope no option names.** It is *not* passed in: the
hook reads `useSessionStore().activeEnvironmentId` itself, so every caller
resolves against the environment the user has actually selected and no caller
can scope a preview to a different one. This page documented an
`environmentId` option for a while; nothing has ever accepted one. The two
scopes are asymmetric on purpose - the active environment is app-wide state,
while the collection is a property of whatever the caller is rendering.

`ResolvedVariable` carries `sourceId` / `sourceName` - the specific environment
or collection the winning value came from (absent for `global`).

`getVariableOrigins` returns **every** definition of a name, lowest precedence
first, including disabled ones that never resolve. Display-only; the variable
popover renders it as "also defined". See `docs/app/variable-resolution.md` for
why the losers are kept and why the MCP copy is not given the same accessor.

### `RequestBuilderContext` - variable members

The request builder re-exposes the resolver plus two things only it can derive:

```typescript
getVariableOrigins: (name: string) => VariableOrigin[]
updateVariable: (name: string, value: string, scope: VariableScope) => void
writableScopes: VariableScope[]
```

`writableScopes` lists the scopes `updateVariable` would actually write to.
Each of its branches opens with a guard (`if (!activeEnvironmentId) return`), so
a write to a scope with no active target is a **silent no-op** - the variable
popover uses this list so its "create in" picker cannot offer one.

A write through `updateVariable` always sets `enabled: true`. Setting a value
means "make this value apply"; enabling and disabling belongs to the variables
editor. Without it, creating a value for a name that was disabled everywhere
preserved `enabled: false` and the token stayed unresolved.

**Usage:**
```typescript
const { resolveString } = useVariableResolver({ collectionId });
const resolvedUrl = resolveString("https://{{baseUrl}}/api/users");
```

### `RequestBuilderContext` - body drafts

```typescript
bodyDrafts: React.MutableRefObject<BodyDrafts>
```

What the body modes you are not looking at were holding. A request stores
**one** body - the shape is a discriminated union, `{"mode":"json","content":
"..."}` - so JSON, text and GraphQL share `request.body`, and switching mode
handed the same string to a different reader. Switching from JSON to GraphQL
therefore read the payload as a raw query string and destroyed it.

Two buckets, not eight: `json`, `text`, `jsonrpc` and `xml` are one raw string
differing only in highlighting, so text carries between them deliberately;
`graphql` is an envelope this side parses into two panes and keeps its own; the
two form modes use `formData` / `urlEncoded` and never touch `body`. `jsonrpc`
and `xml` sit in the raw bucket because nothing here reads their text as a
structure - JSON-RPC's frame is completed engine-side at wire time and an XML
document is sent byte for byte, so each pane holds one plain document. The rule lives in
`modules/request-builder/utils/body-drafts.ts`.

Two things about it are deliberate and easy to undo by accident:

- **It lives in the provider, not in `BodyPanel`.** Radix unmounts an inactive
  `TabsContent`, so a panel-local ref is discarded the moment you glance at the
  Headers tab, taking the stashed body with it.
- **The provider does *not* reset it** on a request change. The drafts carry
  their own `requestId` and `switchBody` drops any belonging to another
  request, so a second reset would duplicate that rule - and would fire on the
  request-change effect, which re-runs on more than the id.

Deliberately **not** persisted: a request has one body, and storing payloads it
will never send would put them in exports and in the engine's schema.

### `RequestBuilderContext` - the GraphQL Variables draft

```typescript
getVariablesDraft: () => VariablesDraft | null
setVariablesDraft: (draft: VariablesDraft) => void
```

The Variables pane's raw text, for the same reason and with the same lifetime.
The pane is a JSON editor over one *key* of the GraphQL envelope, and the
envelope cannot always hold what it shows: text that is neither JSON nor a
resolvable `{{template}}` is dropped by `serializeGraphQLBody`, deliberately, so
that the query pane keeps saving while the variables pane has an unclosed brace.
That makes the pane's own text the only copy - and `GraphQLBody`'s component
state the wrong place for it, since the Radix unmount discards a half-typed
variables object exactly as it once discarded a stashed JSON body.

It is beside the mode drafts rather than inside them because it is not a mode's
body (GraphQL's body is already in the `graphql` bucket). It carries its own
`requestId` for the drafts' reason, and `ownVariablesDraft` - not a second reset
in the provider - is what drops one belonging to another request.

### `RequestBuilderContext` - the headers a setting added

```typescript
getAutoContentType: () => AutoHeader | null
setAutoContentType: (auto: AutoHeader | null) => void
getAutoAccept: () => AutoHeader | null
setAutoAccept: (auto: AutoHeader | null) => void
```

Which header row a *setting* added on its way in, so that leaving the setting
can take it back. Two settings own one each: the body mode's `Content-Type`
(written by `BodyPanel`) and the Event stream toggle's
`Accept: text/event-stream` (written by `SettingsPanel`, issue #574). Two named
slots rather than one map keyed by header name - there are exactly two, each
owns a different header, and a map would let a caller read the wrong record by
passing the wrong string.

GraphQL is sent as a JSON envelope and genuinely needs
`Content-Type: application/json`, so `BodyPanel` appends one - but nothing
removed it, so a single visit to GraphQL left the header on the request for
good, including after switching back to `none`, which sends no body at all.

The record is `{ requestId, rowId, value }` and the rule that reads it is
`switchAutoHeader` in `modules/request-builder/utils/auto-header.ts`, called
once per change: it removes the remembered row when the new setting does not
need that same header, then adds whatever the new setting does need - both
halves in one pass over one array, because two `updateField("headers", …)`
calls would compute the second against the array they had before the first.
`panels/body/content-type.ts` is now just the body-mode half: which
`Content-Type` a mode requires, plus the delegation.

Three things it is deliberate about:

- **By row id, not by value.** A `Content-Type` the user typed and the row the
  panel wrote are identical apart from their id, and only ours may be removed.
- **A row whose value has been edited is no longer ours** - retyping it is a
  decision, so it stays and the record is dropped. Merely disabling it is not.
- **A record naming another request is dropped, not applied.** One provider
  serves every request tab, and row ids are not unique across a duplicated
  request.

In the provider rather than in the panels for the drafts' reason and one of its
own: Radix unmounts an inactive `TabsContent`, so a panel-local record is gone
by the next change - and then nothing removes the header, which is the bug the
record exists to fix. Ephemeral, like the drafts: what is persisted is the
header row itself, in `request.headers`.

### `useSaveManager()` - Auto-Save Manager

Orchestrates auto-save for a saveable entity (request, environment, etc.) with debouncing, context registration, and centralized save state tracking. Located in `app/src/hooks/useSaveManager.ts`.

**API:**
```typescript
const {
  forceSave: () => Promise<void>
  status: "idle" | "pending" | "saving" | "saved" | "error"
  isSaving: boolean
} = useSaveManager({
  entityId: string | null           // Unique ID for this entity
  contextName?: string              // Display name (e.g., "Request: GET /api")
  onSave: () => Promise<void>       // Function to persist changes
  hasChanges: boolean               // Whether unsaved changes exist
  enabled?: boolean                 // Disable auto-save (default: true)
});
```

**Features:**
- **Debounced auto-save:** Triggers after the delay the user chose in Settings → General, defaulting to 5000ms (`autoSave.delayMs` in `client-settings-store`, options in `constants/client-settings.ts`)
- **Context registration:** Automatically registers with `useSaveStore()` for app-wide Ctrl/Cmd+S integration and tab LRU coordination
- **Save status:** Updates centralized save store so UI can show "Saving..." or "Saved" indicators
- **Entity switching:** Flushes pending saves when entity ID changes (in cleanup, before unmounting)
- **Saves are queued, never skipped:** a caller arriving while another save is in
  flight waits behind it and gets its own write, so its promise resolves only
  once *its* edits are persisted. Skipping (the old behaviour) meant Cmd/Ctrl+S,
  the quit flush and the entity-switch flush all reported "saved" for edits that
  were never in the flying snapshot - and the switch then reset the provider,
  making them unrecoverable. `performSave` binds `onSaveRef.current` at call
  time rather than when the queue reaches it, so a save queued by the
  entity-switch cleanup still writes the entity being left
- **No `debounceMs` parameter:** the delay is a user preference, not a per-caller
  one, so the hook reads it from the store rather than taking it as an option.
  Turning auto-save off in Settings leaves the entity marked dirty - Ctrl/Cmd+S
  still saves it - but schedules nothing.

`app/src/config/timing.ts` used to carry an `AUTO_SAVE_DELAY_MS: 3000` that
nothing read and that this section documented as the source of truth. It is
deleted; `timing-keys-have-readers.test.ts` now fails on any TIMING key without
a reader, and `useSaveManager.autosave-setting.test.tsx` pins the Settings value
to the timer that actually runs.

**Usage:**
```typescript
const { forceSave, status, isSaving } = useSaveManager({
  entityId: requestId,
  contextName: `Request: ${request.method} ${request.url}`,
  onSave: () => apiService.updateRequest(requestId, changes),
  hasChanges: JSON.stringify(draft) !== JSON.stringify(saved),
  enabled: true
});
```

### `useEntityDraft()` - Manual Draft/Save Model

The other save model, and the counterpart to `useSaveManager()`: an editable draft, a Save button gated on `isDirty`, and a Reset that discards it. Located in `app/src/hooks/useEntityDraft.ts`. `CollectionDetail`'s `AuthTab` is its one remaining button user.

`InfoTab` and `ScriptTab` use the hook without the button: they want the draft, the resync and the mutation reset, but commit when focus leaves the field, like the request builder. `reset` therefore has one caller where `draft` has three.

**Why auth alone kept the button (#446).** Not because a credential outranks a script - the request builder autosaves its own auth through `useSaveManager`. Because a blur inside `AuthFields` is not a completion signal: an OAuth 2.0 config with Advanced open renders 20 focus stops, 9 of them non-value controls (pickers, switches, the reveal toggle, Get Token), and clicking reveal to check a half-typed password fires `focusout` while the draft is dirty - so a blur-commit would write half a credential to the record every descendant request inherits from. The fields only make sense written together. A script tab has one focus stop, so leaving it means what leaving a description means. Should collection auth ever persist by itself, the mechanism is the debounce, not a blur - a different change from this one. `AuthTab` states its save model above the fields, since it is the tab on that screen that differs.

**API:**
```typescript
const {
  draft: T                                 // The editable copy
  setDraft: Dispatch<SetStateAction<T>>    // Standard setState signature
  isDirty: boolean                         // Draft differs from the persisted value
  reset: () => void                        // Discard the draft
} = useEntityDraft<T>({
  entityKey: string                        // Identity of the thing being edited
  value: T                                 // The persisted value
  mutation: { reset: () => void }          // The save mutation this editor reports through
});
```

**Behaviour:**
- **Seeds and resyncs:** the draft follows `value` when it changes - a save landing, a background refetch. In `InfoTab` this is what clears the post-trim divergence, since the tab persists `name.trim()`. The request builder needs the same property for the same reason and gets it a different way, since its state is not a draft: see [the name it holds is adopted, not captured](#the-request-name-the-builder-holds-is-adopted-not-captured).
- **Tracks by JSON value, not identity:** `value` may be a fresh object literal every render (`InfoTab` builds `{ name, description }` inline); callers do not have to memoize it.
- **`entityKey` is a switch, not an edit:** a change reseeds the draft *and* calls `mutation.reset()`. These editors render without a React `key`, so a different entity arrives via props on the same instance, and a TanStack mutation holds `isError` until the next `mutate` - without the reset, a failed save is reported against an entity the user never tried to save. `ScriptTab` passes `${collection.id}:${fieldKey}`, since pre- and post-request scripts are two different things to edit under one collection id.
- **Requiring the mutation is the point:** the three hand-rolled copies this replaced had drifted, and the one that omitted the reset had exactly that bug.

**Usage:**
```typescript
const { draft, setDraft, isDirty, reset } = useEntityDraft({
  entityKey: collection.id,
  value: collection.auth,
  mutation: updateCollection,
});
```

**The draft lives in component state, so its panel must not unmount.** Radix
unmounts an inactive `TabsContent`; `CollectionDetail` therefore force-mounts the
four draft-holding tabs (Info, Auth, Pre-request, Post-request) from their first
visit onwards, so an intra-collection tab switch stops discarding the draft.
This is the same call, for the same reason, as the request builder's body drafts
living in `RequestBuilderProvider` rather than in `BodyPanel` (see
`request-builder/utils/body-drafts.ts`). The Variables tab is deliberately not
force-mounted: it autosaves and claims the store's active context on mount, so
keeping it alive behind another tab would point Ctrl/Cmd+S at the wrong editor.

A *collection* switch still reseeds and discards, deliberately - it is the
hook's documented behaviour above, and pinned by `useEntityDraft.test.ts`.

### `useDraftSaveContext()` - Registering a Manual Draft

The counterpart to `useSaveManager`'s registration half, for editors using the
`useEntityDraft` model. Located in `app/src/hooks/useDraftSaveContext.ts`. Used
by `InfoTab`, `AuthTab` and `ScriptTab`.

```typescript
useDraftSaveContext({
  id: `collection-${collection.id}-auth`,  // Unique per editor
  name: `Collection auth: ${collection.name}`,
  isDirty,                                 // From useEntityDraft
  isActive: active,                        // Is this the tab on screen?
  save: persist,                           // Rejecting is how failure is reported
});
```

**Behaviour:**
- **Registration only.** It schedules nothing; each editor decides when to call
  its own `save` - `AuthTab` on its Save button, `InfoTab` and `ScriptTab` when
  focus leaves the field. The defect it fixes is orthogonal to that choice: the
  *other* ways to save - Ctrl/Cmd+S, the quit flush, tab eviction - could not
  reach these editors at all, because none of the three tabs ever called
  `registerContext`.
- **`isActive` decides who owns Ctrl/Cmd+S.** `triggerSave` prefers the active
  context, and these editors stay mounted while hidden, so without it the last
  sibling to mount would answer for the panel on screen.
- **A failure toasts rather than resolving quietly.** The editors render an
  inline `SaveFailed` callout for a button press, but a quit flush has no callout
  on screen, and `runSave` reads a resolved promise as success - swallowing here
  would report "Saved" for a write that failed.
- **The save must carry its own validity guard.** A disabled button does not stop
  the store-driven paths, which is why `InfoTab` refuses a blank collection name
  inside `persist`. With its buttons gone that guard is now the only one, and it
  is silent by itself - the tab pairs it with `reportBlankNameRefused()`
  (`lib/blank-name.ts`), which restores the stored name and reports through
  `failSave`.

### The request name the builder holds is adopted, not captured

`RequestBuilderProvider` resets its state when the request **id** changes, and a
rename does not change the id. So the name it held was a snapshot taken when the
tab opened, and the save payload omitted `name` entirely to keep a debounced
auto-save from writing that snapshot back over a rename made in the sidebar
minutes earlier.

The Info tab's name field needs the payload to carry `name`, so the staleness is
removed rather than routed around: the provider watches the incoming
`initialRequest.name` (the request query's copy) and adopts it whenever that
*value* changes, via `setRequestState` - not `setRequest`, because adopting
someone else's write is not an unsaved change and marking it dirty would schedule
a save that writes back what it just read. A name the user is typing is untouched,
because the prop is not what changed.

`restoreStoredName()` on the context is the other half: the Info tab's blank-name
refusal needs the stored name back, and the provider holds the only copy of it.
The payload additionally drops a blank `name` key, since the debounced save can
fire while the field is still empty and the engine does a partial update.

Guarded by `RequestBuilderProvider.name-sync.test.tsx` (adoption, dirtiness, and
restore) and `save-request-name.test.ts` (the payload).

## State Flow Examples

### Executing a Single Request

1. User clicks "Send" button in request builder
2. `useEngine().executeRequest()` is called with request and (optionally) environment ID
3. `useVariableResolver()` resolves any `{{variables}}` in the request URL, headers, body
4. Request is transformed (frontend → backend format) and sent via HTTP
5. Response is stored in `useResponseStore()` keyed by request ID
6. Response viewer component reads the response and displays it
7. On **request tab switch**, the response persists in `response-store` and is displayed if the user returns
8. If any script ran, the environment / globals / collection query families are invalidated so values the script wrote are visible in the variables editor and the resolver. The gate is `scriptsMayWriteVariables(pre, post)` (`request-builder/utils/execute-mapping.ts`), shared by the builder's send path and the History run view's resend. **Both** script kinds count: `pm.environment.set` and friends persist engine-side from a Tests-tab script exactly as from a pre-request one, and with `refetchOnWindowFocus: false` nothing else is coming to correct a stale value

### Starting a Load Test Run

1. User configures load test in the dashboard modal (duration, concurrency, etc.)
2. The request half is composed engine-side (`useEngine().composeRequest()`), then `apiService.startLoadTest()` sends the composed payload plus the load config to `POST /runs`
3. Engine responds with `runId`
4. `useDashboardStore().startRun(runId, config, requestInfo, requestId)` initializes dashboard state
5. `loadTestService.startMonitoring(runId)` connects to `/runs/:runId/live`
6. As metrics stream in, `addMetricsBatch()` folds them into historical metrics (trimmed to `liveWindowSeconds`, backstopped by `maxRetainedTicks`) and updates running aggregates (peak concurrency, SLO breakpoint)
7. Dashboard view shows live metrics, request/response (from the SSE stream's final response), and aggregates
8. When the run completes, the engine sends a `complete` event
9. `LoadTestService.handleClose()` fetches the final report through the query cache (under `queryKeys.runs.report(runId)`, so History reuses it) and stores it in `dashboard-store.finalReport` - **only if the dashboard is still showing that run**. The store is re-read after the await: finishing run A and immediately starting run B otherwise landed A's report on B's dashboard, flipping a running test to "completed" with A's percentiles.
10. Dashboard switches to "completed" mode showing the final report; the runs lists are invalidated so the terminal status lands without waiting for a poll

### Saving a Request with Auto-Save

1. User opens or creates a request tab via `useTabsStore().openTab()`
2. Component mounts `useSaveManager()` with the request ID and save callback
3. Hook registers the context with `useSaveStore()` for Ctrl/Cmd+S integration
4. User edits the request (URL, headers, body, etc.)
5. `hasChanges` is marked true, triggering the debounce timer - `autoSave.delayMs` from `client-settings-store`, 5s by default (Settings → General offers 5s / 30s / 1m)
6. A further change within that window resets the timer
7. After the delay elapses with no edit, `performSave()` is called, which calls the `onSave` callback
8. Save status updates in `useSaveStore()`, and the Dock shows "Saving..." then "Saved" for `TIMING.SAVED_STATUS_DURATION_MS`
9. On **tab switch or unmount**, any pending save is flushed before the context is unregistered
10. On **app quit** (Electron `before-quit`) *and* on **window close** (the X
    button), `useSaveStore().flushAll()` saves all dirty contexts

**Both window-destroying paths flush, through one coordinator.** `before-quit`
always did; `close` did not, and `close` is what the X button fires - it
destroys the WebContents and nulls the window handle, so the `before-quit` that
followed found no renderer to ask and skipped the flush entirely (on macOS,
`close` does not quit at all, so the edits were simply gone with the app still
running). `electron/save-flush.ts` owns the once-only flush and the 2s ACK
ceiling for both, which is also why "already flushed" is shared state: a quit
that flushed and then closes the window must not ask a dying renderer twice.
It lives outside `main.ts` so it can be tested - `main.ts` creates windows and
starts the engine at import time.

### Variable Resolution Priority

1. User activates a request in a tab. The environment comes from `useSessionStore().activeEnvironmentId`; the collection comes from the request's own `collectionId` - **not** from the session store, which has held no collection scope since the `vayu.session` v2 migration
2. Component calls `useVariableResolver({ collectionId })` - the environment is not passed, the hook reads it from the session store
3. Hook fetches globals, collection variables, and environment variables via TanStack Query
4. When `resolveString("https://{{baseUrl}}/{{path}}")` is called:
   - First, check environment variables for `baseUrl` and `path`
   - If not found, check collection variables
   - If still not found, check global variables
   - Replace with the first match found, or leave `{{variableName}}` unreplaced if no match

## Best Practices

1. **Cross-cutting vs. module-local:** Store cross-cutting UI state (tabs, layout, engine, save) in `app/src/stores/`; store feature-specific UI state (collections tree, history filters, variables category, settings category) in `app/src/modules/<feature>/<feature>-store.ts`.

2. **Zustand for transient UI state:** Use Zustand for UI state that doesn't persist to disk (or is ephemeral per session). Decorate with `persist` middleware to survive page reloads if needed (e.g., open tabs, drawer state).

3. **TanStack Query for server state:** Use TanStack Query for collections, requests, environments, globals, runs, and reports. It is the single source of truth and ensures consistency across the app.

4. **Save manager integration:** Use `useSaveManager()` in any component that edits a persistable entity (request, environment, etc.) that autosaves. It handles debouncing, context registration, and centralized save state. Do not manually call `useSaveStore()` for auto-save. For an editor that holds a draft instead - committing it on blur or on an explicit button - use `useEntityDraft()` **plus `useDraftSaveContext()`** - the first owns the draft, the second puts it in the registry - and do not hand-roll the draft/resync/`isDirty`/mutation-reset parts again.

5. **Centralized save on app quit:** On Electron's `before-quit` event, call `useSaveStore().flushAll()` to persist any pending changes before the app closes. An editor that is not registered is not merely unsaved here, it is invisible - which is how the collection tabs lost drafts silently for as long as they existed.

    Corollary: **an editing surface must never fail without saying so.** There is no global `MutationCache.onError` in `lib/query-client.ts`, so a bare `mutation.mutate(...)` reports nothing at all. Route the failure through `failSave` (toast + status) or render the mutation's `isError`, and roll an uncontrolled input back to the stored value while you are at it - the context bar's variables section did neither, so a rejected edit sat on screen looking committed.

6. **Leaving an editor saves or asks; it does not drop.** A settings category switch, an unmount, a tab switch - each used to discard dirty state silently in at least one place. Settings flushes its valid edits on the way out (engine config writes are cheap merge-patches); the collection tabs keep their panels mounted so there is nothing to discard.

7. **Tab LRU and dirty state:** The tab store reads the save registry and refuses to evict a dirty tab (`isTabDirty`, matched by tab *type* - the registry is keyed by editor and the two do not line up). Nothing is flushed during eviction, because the predicate has already declined to take unsaved work; over the cap with every candidate dirty, no tab closes at all.

8. **Response persistence:** Responses are stored in memory (not localStorage) so they survive tab switches but are cleared on page reload. This balances UX (quick switch back) with memory (responses can be large).

9. **Live metric retention is a time window, not a point count.** `addMetricsBatch` trims ticks older than `liveWindowSeconds` (the engine's `liveReplayWindowMs`, 5m by default, `null` = full run), with `maxRetainedTicks` (`DEFAULT_MAX_RETAINED_TICKS`, 50,000) as a memory backstop. Both are engine config so the replayed span and the displayed span cannot disagree. The only knob in `config/metrics.ts` is `METRICS_UI_THROTTLE_MS`, the SSE commit throttle; chart cost is bounded by bucketing (`chartBucketSeconds`), not by dropping ticks.

10. **Variable resolution priority:** Always resolve variables in priority order: environment > collection > global. Use `useVariableResolver({ collectionId })` to scope a preview to a collection; the active environment comes from the session store and is not a parameter.

11. **Lazy loading and prefetch:** Use `usePrefetchCollectionsAndRequests()` on app init to warm up caches. Lazily fetch environments, globals, and run reports only when needed to reduce initial bundle size and API load.
