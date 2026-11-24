---
description: >-
  The Zustand stores that live inside one feature module: collections, history, variables, settings, logs and the GraphQL explorer.
---

# Module-Local Stores

Module-local UI stores co-locate in `app/src/modules/<feature>/<feature>-store.ts` and manage feature-specific UI state that should not leak into the global store tree.

## `modules/collections/collections-store.ts` - Collections Tree Expansion

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

**Every action here has a caller, and expanding is idempotent.**
`expandCollection` (one id) and `expandCollections` (an ancestor chain) both return the *same* Set when nothing changes, because it is passed down the whole tree and listed in effect dependencies - a fresh Set for a no-op re-renders every row and re-runs the reveal effect.
That is why the tree calls them instead of hand-rolling `if (!expanded.has(id)) toggle(id)`, which reads the set it writes and so drags `expandedCollectionIds` into the dependencies of everything that expands.
`collapseCollection` and `reset` used to live here with no callers at all; collapsing goes through `toggleCollectionExpanded`.

## `modules/history/history-store.ts` - History Filter & Sort

UI-only: Search, filter (type/status/pinned/origin/outcome), and sort (newest/oldest) for the history tab.

**State:**
```typescript
{
  searchQuery: string
  filterType: "all" | "load" | "design" | "scenario"
  filterStatus: "all" | "pending" | "running" | "completed" | "stopped" | "failed"
  pinnedOnly: boolean
  filterOrigin: "all" | "app" | "mcp"
  filterOutcome: "all" | "passed" | "failed" | "not_judged"
  filterClient: string | null   // an MCP client's display name; client-side only
  sortBy: "newest" | "oldest"
}
```

**Helper:** `filterRuns(runs, filters)` re-applies the type, status, pin, origin and outcome filters the engine already applied, then narrows by MCP client and sorts, over the loaded pages.
Search is **not** handled here: `searchQuery` is debounced into the server-side `q` param (see `useRunsQuery`) so it covers all runs, not just the pages loaded into the sidebar.

`pinnedOnly` is server-side for the same reason - it drives `GET /runs?baseline=true`, so a pin older than the loaded pages is still findable - **and** applied again in `filterRuns`.
That second pass is not redundant: unpinning patches the loaded pages in place rather than refetching them (see `useSetRunBaselineMutation` below), so the row just unpinned would otherwise sit in the pinned-only list until the next poll.
The param decides what is fetched; the pass decides what is shown.
`false` is never sent: the engine reads `baseline=false` as "only unpinned runs", so the off state omits the param entirely.

`filterOrigin` has the same two halves (#1817): a kind other than `"all"` is sent as `GET /runs?origin=<kind>` through `useRunsQuery`'s third argument, and `filterRuns` re-applies it on `run.origin?.kind` - a run from an engine older than the field has no origin and shows under neither entry.
`filterClient` narrows `"mcp"` to one client and is **client-side only**; the engine filters on kind, not on a client's name.
It holds the client's **display name** (`mcpClientDisplayName`, `lib/mcp-client-names.ts`), so two spellings of one product are one entry, and `setFilterOrigin` clears it because a client belongs to the kind it was picked under.
`mcpClientNames(runs, selected)` lists the Select's per-client entries from the rows *before* the client narrowing, so choosing one client does not hide the others.

`filterOutcome` (#3547) has the two halves again: a verdict other than `"all"` is sent as `GET /runs?outcome=` through `useRunsQuery`'s sixth argument, and `filterRuns` re-applies it from the row's stored `outcome`, or from `rowOutcome` for a row without one (`rowStoredOutcome`, `run-outcome.ts`).
A row the history draws no verdict for matches none of the three values.
A `failed` status is `failed` for every run type, summary or not (#3643), but a failed row stored before the column has no stored outcome: `rowOutcome` draws it failed, while the engine's `outcome=failed` page does not return it, so the filter does not list it.

**Key Methods:**
```typescript
const {
  searchQuery, setSearchQuery,
  filterType, setFilterType,
  filterStatus, setFilterStatus,
  pinnedOnly, setPinnedOnly,
  filterOrigin, setFilterOrigin,
  filterClient, setFilterClient,
  sortBy, setSortBy,
  resetFilters
} = useHistoryStore();
```

## `modules/variables/variables-store.ts` - Variables Category Selection

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

## A variable-map write merges onto the freshest map, never onto its own copy

`PUT /environments/:id`, `PUT /globals` and `PUT /collections/:id` replace the whole `variables` map, so any writer holding less than the freshest map risks carrying a key it never touched back to its pre-write value.
Two surfaces write these maps and both go through `lib/variable-merge.ts`'s `mergeVariableChanges` rather than each re-deriving the read-fresh-merge-write shape (#1439):

- **The context bar's `useVariableCommit`** (`components/layout/context-bar/ variable-commit.ts`) commits one key.
  `CommitScope.read()` re-reads the query cache **at commit time**, not the value the input was rendered with, and `mergeVariableChanges` applies the one changed key onto it before `write`/ `mutate`.
- **`VariableTableEditor`** (`modules/variables/main/`) commits every row the user has actually edited.
  `planSave` diffs the current rows against `baselineRef` - the map the table last agreed with the server on - to get a `VariableChanges` of only the touched keys, then merges that onto `freshMapRef`, the freshest map the editor knows:
  the query cache's `dataVariables`, which stays current even while the row-init effect below is refusing to reseed, with each landed save's own changes applied over it until that save's cache echo arrives.
  A key nobody touched - an MCP agent's `update_environment` landing while the table has an unrelated unsaved edit - therefore survives the next save regardless of what the editor's own copy of it says.

**The editor's saves run one at a time (#3353).**
A blur followed by a toggle asks for two saves; the second waits for the first, and a third asked for while one is already waiting joins it.
A waiting save binds its entity (the context id and the mutation that writes it) when it is asked for, but reads the rows, the baseline and the fresh map when it starts, so it carries everything typed meanwhile and merges onto the map the first save left in `freshMapRef` - its own diff against the advanced baseline no longer names the first save's keys.
Two saves in flight could land out of order and leave `baselineRef` at the older map, so a later external write was compared against the wrong pre-image; and a second `mutate` on one TanStack mutation stops the first call's callbacks from firing, so that save's promise never settled.
Those per-call callbacks also never fire once the editor has unmounted (TanStack runs them only while the observer has listeners), so a save settles from `mutateAsync`'s promise as well, whichever answers first: a save in flight at unmount still settles, and the one queued behind it still goes out.
A throw before the request is sent settles the save as a failure, so the queue is never left waiting on nothing.
If the editor switches entity before a waiting save starts, the save computes from the snapshot taken when it was asked for and, when it lands, touches nothing of the scope now on screen.
It reports nothing under the id the editor discarded either: a `reportSaving` would take the abandoned id back, and its failure would then sit on the Dock as "Not saved" for rows no editor holds.
Its failure is a plain toast, the rule for any write that lands after its editor let go.
A save for an environment or collection that is no longer there reports `Couldn't save - this environment no longer exists` (or collection) and resolves `"final"` rather than sitting on "saving" until the quit flush's ceiling.
Every save resolves with its `SaveOutcome` and never rejects, so the blur and toggle callers, which do not await it, cannot leave a rejection unhandled.

**A key both sides touched is a conflict, not a coin flip.**
While the table is dirty, the row-init effect recomputes the same diff against `baselineRef` on every `dataVariables` change purely to call `findVariableConflicts`, which reports a key only when the fresh map *and* the user's edit both moved it away from the baseline to different values.
The table renders one `Callout` per conflicting key naming it, with "Keep mine" and "Take theirs" actions, and **a save leaves a conflicted key out until the user picks one** (#3353): the other writer's value stays on disk, the user's stays on screen, and the editor stays dirty, so the Dock says "Unsaved changes".
Saving the user's value by default would be choosing for them.
Both actions set the key's baseline to the other writer's value and save at once: "Keep mine" then reads the row as the user's change over it, "Take theirs" first replaces the row with it.
That is the row standing for the stored key (`rowIndexFor`): one the user renamed away from it is renamed back, and a name is compared trimmed, as it is saved - matched by its raw name, a renamed row was missed and the save still sent the user's delete.
Deleting a conflicted row is "Keep mine" for that key.
`baselineRef` itself only advances on a full reseed, on this editor's own successful save (to the map that save wrote, so a later write is never compared against this save's own history - except a key the save held back, which keeps its baseline so its conflict stays open; conflicts are then recomputed against the new baseline, never cleared), and when the user picks a side -
never merely because the table was dirty when a fresh write arrived, since a key nobody has touched needs no conflict bookkeeping at all.

## `modules/settings/settings-store.ts` - Settings Category Selection

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

## `modules/logs/logs-store.ts` - The Logs Tab's Lines

UI-only, in memory: the log lines the bottom panel's Logs tab holds (#3635), the controls that choose them, and the paged read and tail that fill them.
The tab's mount is the store's lifetime: `start()` on mount, `stop()` on unmount, which ends the tail, drops the lines and ignores anything main pushes afterwards.

**State:**
```typescript
{
  controls: { minLevel, source, category, search },
  records: LogEntry[],            // oldest first
  bytes: number,                  // entryBytes' estimate of `records`
  follow: boolean,
  cursor: LogCursor | null,       // where "Search older" continues; rebuilt on every trim
  more: boolean,
  scannedTo: string | null,       // "Searched back to <time>"
  dropped: number,                // lines the tail left out of a batch
  detached: boolean,              // the newest lines are not all held
  newerCursor: LogCursor | null,  // where "Search newer" continues after a jump
  newerScannedTo: string | null,  // "Searched forward to <time>"
  status: "idle" | "loading" | "ready" | "error",
  loadingOlder: boolean,
  loadingNewer: boolean,
  error: string | null,
  knownCategories: string[],      // the component filter's options
  generation: number,             // bumps when the list is replaced
  jumpTarget: string | null,      // the ISO time a jump landed on; null for any other replacement
  jumpPaging: boolean             // a jump's first page newer is still being read
}
```

**Key Methods:**
```typescript
const { records, follow, controls, start, stop, setControls, setFollow, loadOlder, loadNewer, jumpTo, reload } =
  useLogsStore();
```

**Filters are evaluated in main, never here.**
`setControls` rebuilds the filter (`buildLogFilter`, with the search box read by `parseSearchInput` in `modules/logs/parse-search.ts`, a renderer copy of the reader's own that `electron/log-search.conformance.test.ts` holds equal) and, when it differs, restarts the tail with it and replaces the held lines with a fresh read.
The tail starts before the read, so a line written while the read answers waits in a buffer and is merged in once, never lost or doubled.
The read then runs to the files' ends, past where the tail started, so the tail's first batches after it can repeat the read's newest lines: each batch is checked against the read that attached the tail (`pastOverlap`), and the first batch that repeats none of it ends the check.
A fresh read and the page newer that reaches the end of the logs both attach this way.

**The bound** is `LOG_MAX_RECORDS` lines (10,000) or `LOG_MAX_BYTES` (16 MiB by `entryBytes`: two bytes per UTF-16 unit, as `estimateResponseBytes` counts a body, of the record serialised with the raw line and the position it carries, so its parsed fields, that line and the position all count; an unparsed line counts as its raw text and its position), whichever comes first.
Following drops the oldest.
"Search older" (`loadOlder`) turns follow off and drops the newest, and having dropped any the list is `detached`: later tail batches are not appended, since they would sit after a hole, and `setFollow(true)` reads the newest lines afresh instead.
`jumpTo` is detached the same way, for the same reason, and pages newer from where it landed: the `around` read's `newer` cursor feeds one `after` read of 100 lines at once (half a step of the list's window, which opens a few lines before the time with the page below it, so the whole page mounts beside them, under the cap; `useLogWindow`), then one per "Search newer" (`loadNewer`, 1,000).
`jumpPaging` is true from the jump's list until that first page has landed, failed or been set aside, and the window and the scroll to the time wait for it (a window settled earlier would be anchored before the page's rows exist).
Paging newer drops the oldest.
Each page newer restarts the tail before it reads, as a fresh read does, so the page that reaches the end of the logs (`more: false`) appends what the tail delivered meanwhile, once, and attaches: `detached` false, `newerCursor` null, Follow left off until the reader scrolls to the end.
Paging older that drops the newest ends paging newer (`newerCursor` null), and a page newer still in flight then lands nowhere, since it would sit after the hole.
Whatever drops the oldest (the tail, a page newer, a read over the byte budget) rebuilds the older cursor from the `$pos` every delivered line carries (`cursorAfterTrim`, #3652): per file, the latest of the start of its oldest held line, the end of its newest dropped line and the file's entry in the cursor before;
files are matched by `id` (by `name` where it is empty), and an entry at offset 0 is left out.
Each file's minimum is taken over every held line, not read off the first, because held order is not time order across files: a tail batch is sorted per poll, and a lagging file's lines arrive late.
Nor is it file order within one file: a batch is sorted by `ts`, which engine threads can write out of order, so a trim can drop a line that lies after one it keeps (#3658).
The cursor then sits past that held line, and stays there through a later trim that drops nothing of that file until a page older reads the line, which is why the entry before counts toward the maximum (a page older, and the read before any trim, leave it at or below every held start).
The page merge refuses every line whose place (`$pos` file and `start`) is already held (`notHeld`); by place rather than by text, so two lines that read alike, an unparsed line repeated, are both kept.
`more` is then true whenever an entry remains and `scannedTo` is cleared, so "Search older" reads every dropped line and the lines before them, none skipped or repeated, a line a burst left out included.
The trim always makes a new cursor object, and a page older still in flight (requested against the old one) would sit behind the lines just dropped, so `loadOlder` reads it again from the new cursor, as often as a trim overtakes it, and the one click lands its page (#3658).
There is no cap on those passes: each is a whole read, a cap would only bring back the discarded click, and `stop()` or a filter change ends the loop through `loadId`.
A line without a `$pos` (only a fixture built outside the reader) cannot be placed, and a trim over one ends paging older (`cursor` null, `more` false) rather than guess.
A single line over the byte budget is kept, alone, as a response over the response cache's budget is.

**Every async step checks `loadId` before it writes**, and `stop()` bumps it, so a read that answers after a filter change or after the tab closed lands nowhere.
`loadId`, the tail's buffer and the unsubscribe are module variables, not state: nothing renders from them.

## `lib/graphql/explorer-store.ts` - GraphQL Schema Explorer View

UI-only, in memory: whether the schema explorer pane is open, and per schema identity the search text, the expanded row ids, the scroll position and whether rows show their full description or one clipped line.

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

`showDescriptions` is per schema like everything else here: how much documentation a user wants on screen is a property of the schema being read, and an endpoint that documents nothing has nothing to answer for.

**A store rather than component state, because the pane is unmounted for no reason the user did.**
Radix tears the whole Body tab down on every glance at Headers or Auth - the same unmount the [body drafts](request-builder-context.md#requestbuildercontext---body-drafts) exist for - and a component-state explorer comes back collapsed to its roots with an empty search box.

**Keyed by schema identity**, using the schema cache's own `schemaCacheKey`, so two requests against one endpoint share the tree they have opened and the same URL reached with different credentials does not.
Deliberately not persisted and capped at `EXPLORER_VIEW_MAX_ENTRIES` (8, matching the schema cache): an expansion set is a description of a schema that may not exist next launch.

## `lib/graphql/reveal-store.ts` - GraphQL Outline Click-to-Scroll

UI-only, in memory: one slot holding the operation the context bar's GraphQL outline asked the query editor to scroll to, until something serves it.

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

**A store because the two ends cannot see each other.**
The outline lives in the context bar, outside `RequestBuilderProvider`; the Monaco instance lives inside `GraphQLBody` and stays there, the way the insert machinery applies its edits in-component rather than handing the editor out.
What crosses the boundary is a request to reveal, not an editor.

**Consume-and-clear**, for the reason the insertion effect records: a command left in the slot is replayed on the next render and the next remount, and Radix remounts the Body tab on every glance at Headers.
`GraphQLBody` clears it once served **and** when it cannot serve it (the operation was renamed away, which it says out loud); the provider clears one naming another request or a request whose body is no longer GraphQL, since nothing under it can ever serve those.
The provider's other half is bringing the Body tab forward - the editor does not exist while another tab is on screen.

**A command names its request** for the reason the [body drafts](request-builder-context.md#requestbuildercontext---body-drafts) do: only one request builder is mounted at a time, so a mismatch takes a click and a tab switch in the same tick, and the cost of not carrying the id is another request's editor jumping to a line number that means nothing there.
