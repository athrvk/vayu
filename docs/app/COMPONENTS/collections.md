---
description: >-
  The collections module of the Vayu desktop app: the sidebar tree, import, and the collection detail screen.
---

# Collections (`modules/collections/`)

| Component | Role |
|---|---|
| `CollectionTree.tsx` | Hierarchical tree of collections + requests in the sidebar; expandable folders, context menus, method badges. [Details](#collectiontreetsx) |
| `context/CollectionTreeContext.tsx` | Everything a row needs that is not the row itself, in three contexts split by how often the value changes (#2543). [Details](#contextcollectiontreecontexttsx) |
| `useRevealActiveSelection.ts` | The two once-per-selection effects that keep the active tab's row rendered and on screen: expand its ancestors, then scroll it into view. [Details](#userevealactiveselectionts) |
| `useTreeDnd.ts` | The drag machinery: one set of pointer handlers on the `role="tree"` element (`treeHandlers`, #2543). [Details](#usetreedndts) |
| `tree-row-dnd.ts` / `TreeRowDnd.tsx` | The per-row half of the drag machinery, shared by both row types: `useRowDnd`. [Details](#tree-row-dndts--treerowdndtsx) |
| `MoveToDialog.tsx` | The row menu's "Move to…": a tree-ordered picker of every collection the row may move into. [Details](#movetodialogtsx) |
| `useTreeCrud.ts` | Create, rename, duplicate and delete for the tree, with the inline form state each drives. [Details](#usetreecrudts) |
| `tree-rows.ts` | The tree as the rows a user can see (#2543): `flattenVisibleRows` lists them in order. [Details](#tree-rowsts) |
| `CollectionTreeRows.tsx` | Renders that list flat under `role="tree"`, one wrapper per row, windowed (#2543). [Details](#collectiontreerowstsx) |
| `useTreeWindow.ts` / `tree-window.ts` | The window: which rows the drawer body can show plus ten rows of overscan each way. [Details](#usetreewindowts--tree-windowts) |
| `NewFolderForm.tsx` | The inline "new collection" form a folder row opens, a row of the list at its children's depth. The one reader of `CollectionTreeFolderDraftContext`, so a keystroke renders this form and no row |
| `CollectionItem.tsx` | A collection (folder) row, wrapped in `memo` (#2543); everything but its entity and position comes from the contexts. [Details](#collectionitemtsx) |
| `RequestItem.tsx` | A request row (method badge, click → open in RequestBuilder), wrapped in `memo` like `CollectionItem` (#2543). [Details](#requestitemtsx) |
| `tree-row-menu.ts` | A row's actions and its menu's name, for both menus that show them (#2543). [Details](#tree-row-menuts) |
| `CollectionTreeContextMenu.tsx` | The tree's one right-click menu (#1360, #2543): the `role="tree"` element is the only trigger. [Details](#collectiontreecontextmenutsx) |
| `ImportModal.tsx` | Import collections from a file, a URL, pasted text or a live MCP server (Postman / Insomnia / OpenAPI / JMeter). [Details](#importmodaltsx) |
| `ImportMcpForm.tsx` | The Import dialog's MCP server tab: server URL, headers, bearer token and the primitives to list. [Details](#importmcpformtsx) |
| `ImportClientCertificates.tsx` | The footer section of `ImportModal` that offers a Postman import's client-certificate candidates for registration (issue #2363). [Details](#importclientcertificatestsx) |
| `import-notices.ts` | What a parsed file lost or changed, as the lines the import preview and every batch ledger row show. [Details](#import-noticests) |
| `NoticeList.tsx` | The lines `importNotices` writes, drawn: amber for what the user finishes by hand, muted for what the import decided. [Details](#noticelisttsx) |
| `import-report.ts` | What an import does once it is applied (issue #2109): `buildImportReport` and `announceImport`. [Details](#import-reportts) |
| `import-environment.ts` | The active environment after an import (issue #2115): `planEnvironmentActivation` and `activateImportedEnvironment`. [Details](#import-environmentts) |
| `tree-utils.ts` | Every `parentId` walk in the renderer: `walkAncestors`, `collectionPath`, `isDescendant` and the rest. [Details](#tree-utilsts) |
| `tree-children.ts` | `childrenOf(parentId, ...)`: a parent's sub-folders and requests as the one list the tree shows (#2535). [Details](#tree-childrents) |
| `drop-position.ts` | Where a drop lands: 25/50/25 bands on a folder row, 50/50 on a request row, resolved to a parent plus an anchor row. [Details](#drop-positionts) |
| `reorder-math.ts` | The arithmetic behind a drop: `planMove` turns a sibling list and a target index into the `POST /reorder` batch. [Details](#reorder-mathts) |
| `CollectionDetail/` | The collection editor screen (see below) |

## `CollectionTree.tsx`

Hierarchical tree of collections + requests in the sidebar; expandable folders, context menus, method badges.
Layout and the panel chrome only - the reveal effects, the CRUD state and the shared row values each live in their own module below.
The toolbar's Add request goes through `hooks/useNewRequest.ts` like every other "New request" entry point (remembered collection, else the only one, else the picker it renders), with one override: an open collection tab names the collection.
With no collections it creates a default one and the request, rather than opening the new-collection form.
The chevron beside it, **New request from a template** (#3778), is a dropdown of `welcome/llm-request-presets.ts`'s `LLM_REQUEST_TEMPLATES` (a streaming OpenAI-compatible chat completion and an Anthropic-style messages request); each item calls `newRequest(preset, { collectionId })` with the same override as the plus, never `newRequest` as a click handler.
The palette generates its two `New request: ...` commands from the same list, and `CommandSurfaces.newRequest` takes the optional preset ([guide](../testing-an-llm-api.md)).
State from `useCollectionsStore` + `useCollectionsQuery`/`useRequestsQuery`.
It hands `useRovingTreeFocus` the visible rows as a `TreeRowModel` (`navigableRows`), so the keys walk every row rather than the mounted ones, and moving focus goes through the window's `revealRow`

## `context/CollectionTreeContext.tsx`

Everything a row needs that is not the row itself, in **three contexts split by how often the value changes** (#2543), because every consumer of a context re-renders when its value does.
`CollectionTreeHandlersContext` holds the functions plus the `dnd` slice (`useTreeDnd`'s, `null` where no drag machinery is mounted, which is what a test rendering one row gets): its identity holds across a keystroke and a pointer move, and it changes only when the collections a render-time function (`getCollectionActions`) describes do.
`CollectionTreeStateContext` holds the tree's data (collections, the expanded set, the selection, the requests lookup) and the rename / delete / new-folder-open state.
`CollectionTreeFolderDraftContext` holds the half-typed new-folder name and nothing else, read only by `NewFolderForm`.
Rows read them through `useCollectionTreeHandlers()` / `useCollectionTreeState()` / `useCollectionTreeFolderDraft()`, each of which throws when a row is rendered without `CollectionTreeProviders` (`context/CollectionTreeProviders.tsx`, the one nesting the tree and the test helper share).
The drag indicator (`dragging`, `dropTarget`: the row key it is drawn on, and for a line its edge and the depth whose indent it starts at) is deliberately not a context: it changes on every row the pointer crosses, so it is a zustand store on `dnd.dragState` that each row subscribes to with a selector, and a crossing renders the two rows whose answer changed.
`CollectionTree.render-count.test.tsx` pins both with 300 mounted requests

## `useRevealActiveSelection.ts`

The two once-per-selection effects that keep the active tab's row rendered and on screen: expand its ancestors, then scroll it into view.
Separate refs, because the scroll can only run a render after the reveal.
Also returns `revealEntity`, the imperative version a move calls: a move does not change the selection, so nothing in those effects would fire.
Both scrolls go through the window's `revealRow` (below), never the row element: the row may not be mounted until the drawer has scrolled to it, and the window scrolls the drawer body alone where `scrollIntoView` would move every scrollable ancestor (#1612)

## `useTreeDnd.ts`

The drag machinery: one set of pointer handlers on the `role="tree"` element (`treeHandlers`, #2543) - a press resolves its row from the rows model (`entityAt`), never from a handler on the row - plus pointer capture, hit testing, spring-loaded folders, auto-scroll, Alt+Arrow moves, the row menu's Move up / Move down / "Move to…" entries, the "Move to…" dialog state and the undo offer.
Everything decidable without a DOM is delegated (`lib/drag/drag-gesture.ts`, `drop-position.ts`, `reorder-math.ts`, `useReorderMutation`), and all four ways a row can move go through one `applyPlacement` so the write, the announcement and the reveal cannot drift.
The capture is the tree's, so a source row scrolled out of the window cannot take the gesture with it, and it is taken when the press becomes a drag rather than at the press: a captured press clicks the capturing element, and a click on a row has to land on the row's own controls.
A press carried out of the tree before it is a drag is dropped (`onPointerLeave`), since without the capture its release never arrives.
A drop on an empty folder's "Empty collection" line, which is no treeitem, resolves to inside its folder through the line's `data-tree-empty-owner` (#3447).
Where a line is drawn comes from the rows model (`dropLineBeside`, passed in by `CollectionTree`), so a line after an open folder sits under its last visible row.
The hit test (`hitTestDrop`) runs from the last pointer position on every move and again after every auto-scroll frame, since a scroll changes the row under a pointer that has not moved.
Every position is an index in the parent's merged sibling list (`childrenOf`): Alt+Up/Down step past a row of either kind, Alt+Right moves into the sibling directly above only when it is a folder, Alt+Left lands right after the parent, and "position X of N" counts both kinds

## `tree-row-dnd.ts` / `TreeRowDnd.tsx`

The per-row half, shared by both row types: `useRowDnd` (drag/blocked/indicator state, no handlers since the tree holds them - each read from the drag store through its own selector, so a row renders only when its own answer changes - and the row menu's move entries - Move up, Move down and "Move to…", the chord-free reorder path added by #1690, off at the ends with the reason on the item), `rowDndClasses`, the 2px `--primary` drop line indented to the depth the drop target carries, which under an open folder's last row is the folder's, not the row's (`RowDropIndicator`, the horizontal case of the shared `DropIndicator`; `RowDropIndicatorFor` / `useRowDropLine` for the "Empty collection" line and the new-folder form, which have no `useRowDnd`), and the four hidden `data-tree-move-*` Alt+Arrow controls

## `MoveToDialog.tsx`

The row menu's "Move to…": a tree-ordered picker of every collection the row may move into, minus itself, its own subtree and the parent it already has.
The row lands after every child of the destination, both kinds.
The chord-free path to the same move

## `useTreeCrud.ts`

Create, rename, duplicate and delete for the tree, with the inline form state each drives.
Returns `panel` (what the tree's own chrome renders) and, for the contexts, `handlers`, `rowState` and `folderDraft`.
The handlers a row calls from an event go through `hooks/useStableCallback.ts` (one identity, the latest render's closure) rather than a `useCallback` over a mutation object that is new every render - that is what keeps the handlers context from changing on a keystroke.
Duplicate copies the whole source record - read through `requestDetailOptions`, since the row it was invoked on is a summary (#2546), then spread, never a hand-written field list, since a named list drops every field added after it was written (issue #1519).
The open editor's pending save is flushed first (read from the save store at click time, no subscription) and the detail is then read past its `staleTime: Infinity` cache, so the copy carries an edit still inside the autosave delay; a save that fails or is declined aborts the Duplicate with an error toast and creates nothing (#3426).
The request's saved examples are a nested resource and follow the create (`copyExamples`, #3450): the list is read fresh, each example is posted to the copy in source order as the user's own (origin `user`, so the next spec sync does not replace it), and a fixed mock example is repointed at the copy's own twin.
A source in `fixed` mode is created in `first` and switched only once that twin exists, since the engine does not check the pointer; an example no longer saved leaves the copy on `first`.
A failure copying examples keeps the copy, opens it and raises an error toast saying the examples did not fully copy.
A delete that lands marks the request ids removed in the save store (`markRemoved`) before it closes their tabs, so a dirty tab's unmount flush is dropped rather than PUT to the deleted row (#3444)

## `tree-rows.ts`

The tree as the rows a user can see (#2543): `flattenVisibleRows` lists them in order - the roots (orphans included, `treeRoots`), and under each expanded folder its new-folder form, the "Empty collection" line when it holds nothing, then its children as **one list**, sub-folders and requests merged in sibling order by `mergeSiblings` (#2535), so a request can sit above or between folders - each with its depth, its parent, its `aria-posinset` / `aria-setsize` over that merged list and a stable key.
`rowSpacingAbove` is the gap above a row, read from depth alone; `rowKeysUnder` is a folder's visible subtree; `dropLineBeside` is where a drop line beside a row is drawn - under the last row of an open folder's visible subtree, at the folder's depth (#3447).
It owns the row keys (`folderRowKey`, `requestRowKey`, `entityRowKey`, `newFolderFormRowKey`), each row's height and stride in spacing units (`rowHeightUnits`, `rowStrides`), the treeitems as the keyboard walks them (`navigableRows`), the rows kept mounted around the tab stop (`rowsAroundFocus`), and the entity a row stands for (`collectionEntity`, `requestEntity`, `rowEntity`), which the rows, the drag and the right-click menu all build through.
Pure and node-tested, so what is on screen is decided without a DOM

## `CollectionTreeRows.tsx`

Renders that list flat under `role="tree"`, one wrapper per row carrying the gap above it (`mt-0.5`, or `mt-1` into a folder), its height (`h-8`, `h-10` for the new-folder form, from `rowHeightUnits`) and the dimming of rows inside a folder being deleted.
**Windowed** (#2543): only the rows in view of the drawer mount, through `useTreeWindow`, and each skipped run is one `aria-hidden` spacer of the same spacing units, so every mounted row sits where the whole list would put it.
Some rows stay mounted wherever the drawer is scrolled: the row holding the tab stop (the last treeitem focus landed in, or the first treeitem before any has) with its neighbours from `rowsAroundFocus` - the rows focus steps to and the three a delete hands it to, remembered for a commit after that row leaves so the refocus still finds its successor mounted; the new-folder form and its folder; the row being dragged, so the source keeps its place and its dimmed state for the whole gesture (the capture is the tree's, so the gesture does not depend on it); and the row a reveal is bringing in.
A row being renamed needs no pin of its own, since its field holds focus for as long as the rename lasts.
The tree acts on a row through the `TreeRowWindow` handle this exposes: `revealRow(key, then)` scrolls the drawer to the row, mounts it if need be and hands `then` its treeitem once it is mounted - the keys, the selection reveal and the moved-row reveal all go through it - and `rowOf(element)` answers which row of the list an event came from, which is how the tree's one right-click menu and its drag handlers find their row.
Memoised on the row array, which `CollectionTree` rebuilds only when what is visible changes

## `useTreeWindow.ts` / `tree-window.ts`

The window: which rows the drawer body (`[data-drawer-body]`) can show plus ten rows of overscan each way, read from a passive scroll listener (one read per animation frame) and a `ResizeObserver`, in steps of 32 units so a scroll re-renders the list every few rows rather than every frame.
Positions are a prefix sum over each row's stride in spacing units (`rowStrides`), binary-searched; the viewport is measured from the list's own top, so the toolbar's new-collection form above it is subtracted.
`--spacing` is read on mount and on every resize (a density change resizes the list), falling back to 4px.
**Everything mounts** below 100 rows and wherever nothing can be measured - no scroller, no `ResizeObserver`, or a scroller with no height - which is what jsdom is, so the tree suites render the whole tree as they always did and `CollectionTree.windowing.test.tsx` stubs the layout to get a window.
This is fixed-stride windowing, not the variable-height kind `hooks/useGrowingWindow.ts` declines: every row's height is set by its wrapper from the same number the arithmetic reads, so there is nothing to measure and no scroll map to keep.
`tree-window.ts` is the pure half (`rowOffsets`, `rowAt`, `visibleRange`, `mountedSegments`, `nearestScrollTop`), node-tested

## `CollectionItem.tsx`

A collection (folder) row, wrapped in `memo` (#2543): its props are its entity, depth, position in the sibling set and, when it is expanded and empty, the id of the placeholder it names in `aria-describedby` - all primitives or query-cache objects, and everything else comes from the contexts.
It renders its own row only; its children are rows of the list.
It mounts no menu of its own for right-click: the tree's one `CollectionTreeContextMenu` opens over it with the same list its `⋯` menu offers (issue #1360), both built by `collectionRowMenu`.
The list is `useTreeCrud`'s `getCollectionActions` plus the drag slice's move entries, whose **Copy for agent** item names the collection with the chain *above* it.
It carries the `own-menu` marker while it has a menu, and drops it with the menu while renaming or deleting

## `RequestItem.tsx`

A request row (method badge, click → open in RequestBuilder), wrapped in `memo` like `CollectionItem` (#2543).
Same prop rule as `CollectionItem`, and the same arrangement for right-click: the tree's one menu, built by `requestRowMenu` like its `⋯` menu.
Its **Copy for agent** item words the request with the folders it sits in (`requestRowReference`: `collectionNamePath` over `allCollections` from the state context)

## `tree-row-menu.ts`

A row's actions and its menu's name, for both menus that show them (#2543): `collectionRowMenu` (the CRUD list with the move entries spliced in before the destructive tail), `requestRowMenu` (Rename, Duplicate, Copy for agent, the move entries, Delete) and `treeRowMenu`, which answers for a row of the flat list and is `null` where a right-click opens nothing - not a treeitem, mid-rename or mid-delete, or nothing to offer

## `CollectionTreeContextMenu.tsx`

The tree's one right-click menu (#1360, #2543): the `role="tree"` element is the only trigger, the row comes from the click through `TreeRowWindow.rowOf`, and the items are `treeRowMenu`'s, drawn with `RowContextMenuContent`.
Decided in the capture phase, before the trigger's own handler: over a row with a menu it focuses the row (so Escape returns there), otherwise it stops the event short of the trigger and the platform keeps its default.
The menu closes if its row starts a rename or delete while it is open. → `CollectionTree.right-click.test.tsx`, `CollectionTree.windowing.test.tsx`

## `ImportModal.tsx`

Import collections from a file, a URL, pasted text or a live MCP server (Postman / Insomnia / OpenAPI / JMeter).
Mounted globally in `Shell`; open-state in a dedicated store.
Entry is per **file**: a multi-file drop or selection, or "Import folder" (`webkitdirectory`, recursed and filtered to `.json/.yaml/.yml`), previews as a **batch ledger** - one row per picked file with its detected format, counts, skip tally or error, and an include checkbox - and applies each file as its own `POST /import/apply`, so one refused file does not undo the others.
One file renders the full preview tree instead, each collection's sub-folders and requests in the one order the sidebar will list them (`draftSiblings`: a Postman or JMeter file's document order, an Insomnia file's sort-key order, every other format's folders first, issue #2535); a file another picked document inlined as a `$ref` target is listed as such and never imported twice.
A document a collection is already bound to forks before the apply into Sync or import-anyway (`SpecReimportDialog.tsx`, issue #680).
**Each of the four tabs holds its own state** - phase, entries, error and progress (issue #893): they were one set for the whole dialog, and switching tab `reset()` them, which cleared the *display* of work that went right on running and then landed under whichever tab was showing when it finished.
So a tab switch now only switches tabs, every async writer patches the tab it started on behind a per-tab generation counter that a close, a reset or an option toggle bumps, and the URL download carries an `AbortSignal` the close actually fires.
The two option checkboxes stay dialog-wide, so a toggle re-parses **every** tab holding a parse rather than the visible one - otherwise the other tab keeps a parse made under the old options.
A toggle bumps the generation before it re-parses (issue #895): a re-parse is an engine round trip per file and the checkboxes stay live for it, so two toggles inside one round trip would otherwise hold the same generation and whichever landed last would win the entries - importing a setting the checkbox says is off, since `importScripts` is baked in at parse time.
They are the only writer that may be superseded that way, which is why the checkboxes close while an apply is in flight: it holds a generation captured before its first file went out, and its outcome write is what reports which files failed.
A document dropped on the OS Dock or taskbar icon opens this dialog on that file (issue #1364): main carries the path in, the dialog reads the bytes back through the same gated `specFile:read` channel a `$ref` sibling uses, and one `BatchDocument` goes into the ledger a picked file goes into - a fourth *source*, not a fourth way to apply an import.
A path that arrives while the dialog is already open is picked up the same way (issue #2275): a preview or read in progress is replaced and a toast says which file replaced it, and an apply in flight refuses the path with a toast, because superseding the File tab would drop the outcome write that reports which files failed.
The packaged macOS app declares the three extensions as `Viewer` at rank `Alternate`, so it is offered in Open With and never becomes the default for `.json`.
A Postman import that resolved client-certificate candidates lists them in the footer through `ImportClientCertificates.tsx` (host, port, certificate path, key path; never the passphrase), one unticked checkbox each, kept per batch entry as `BatchEntry.selectedCertificates`: only the ticked ones reach `POST /import/apply`, and the rest are tallied in the `certificate` notice (issue #2363).
See [import-collections/](../import-collections/README.md) for the batch layer and the parser pipeline

## `ImportMcpForm.tsx`

The MCP server tab's fields, controlled by `ImportModal`: a tab switch leaves the entered values in place, and a reset or close clears them, the bearer token included (it lives in this state and nowhere else).
`import-mcp.ts` beside it holds the form's state, `canConnectMcp` (a URL and at least one primitive) and `mcpImportRequest` (the `POST /import/mcp` body: blank and disabled header rows are dropped).
The connect is `ImportModal`'s `handleConnectMcp`: its own `AbortController` and generation, as the URL download has, and the answer becomes the tab's one batch entry (`mcpBatchEntry`), so the preview and apply are the other tabs' own.
The environment and script checkboxes are not drawn on this tab.
Right after the connect, `existingMcpImports` (`import-mcp.ts`) asks `apiService.importMcpDiff` which collections an earlier import of the URL built and stores them on the entry as `BatchEntry.existingMcp`; it never throws, so a failed comparison is the same as no match.
See [import-collections/mcp-server.md](../import-collections/mcp-server.md).

## `McpReimportDiff.tsx`

The preview's report on an MCP server that was imported before (issue [#3842](https://github.com/athrvk/vayu/issues/3842)): one block per matched collection, with its added, changed and removed counts stated in full, zeros included, and the entries under each.
A renamed tool is one changed row reading `old → new`.
Read-only: the footer's button reads **Import anyway** and makes a new collection as before, and the copy says nothing is changed in the existing one.
It reads the engine's `ImportMcpDiffMatch` shape directly, not the spec sync's `SpecDiff` types.

## `ImportClientCertificates.tsx`

The footer section of `ImportModal` that offers a Postman import's client-certificate candidates for registration (issue #2363).
One checkbox per candidate, unticked by default; absent when no applicable file lists any.
A registry row is host-wide and outlives the import, so nothing registers unless ticked

## `import-notices.ts`

What a parsed file lost or changed, as the lines the import preview and every batch ledger row show - one line per kind, never joined into a sentence.
Each `meta.skipped` kind has a tier: **amber** when a request will not work as imported or something sent is missing, **muted** when the import made a choice, and **not shown** when nothing the user sends changes (`default` responses, a Postman URL assembled from `host[]`/`path[]`); still counted in `meta.skipped` either way.
A count the engine could tie to requests names them (`Upload an image: body not imported (binary file)`, or `3 requests: ... - A, B, C, +2 more`), so the user knows which request to open.
`meta.unsupportedScriptApis` (a Postman script that uses an API Vayu does not run, #2576) is its own amber line, `Sign in: script uses APIs Vayu does not run yet (tests[], CryptoJS)`: the requests named as above, the API names a deduplicated union cut at four.
It is the one notice with a `link` (`{ label, key }`, an `openAppLink` key), to the "Not (yet) supported" section of `pm-api-compatibility.md`.
A JMeter class with no words of its own reads as its class name, never a slug.
Its `describeCounts` is the one count line under a file (`1 request · 3 nested collections · 0 examples`), pluralised and shared by the single-file preview and the batch rows: examples always (0 is an answer, #481), environments and globals only when non-zero, and a file with no requests or nested collections that carries either reads as just those (`1 environment`).
Its `describeCarriedOver` is the single-file preview's second line (`Carried over: 12 variables · auth on 40 requests · scripts on 8 requests`, #2249), read off the drafts: zero segments are left out and a file with none shows no line

## `NoticeList.tsx`

The lines `importNotices` writes, drawn: amber (the `Callout` warning text) for what the user finishes by hand, muted for what the import decided, neither announced as an alert.
A notice's `link` draws as a `link`-variant `Button` at the end of its line that asks the main process for the keyed docs page (`window.electronAPI.openAppLink`, see `electron/app-links.ts`), also inside a batch row's `<label>` without toggling its checkbox.
Also exports `NoticeLine`, the one line `ImportFileFolders.tsx` draws its file-reference follow-ups with.
Shared by the single-file preview and every batch ledger row (`as="span"` inside a row's `<label>`)

## `import-report.ts`

What an import does once it is applied (issue #2109): `buildImportReport` keeps one file's notices, file-reference needs and counts, and `announceImport` records them in `import-report-store`, expands the new roots, opens the first as the active tab and raises one toast - `Imported "Pet Store" - 60 requests, 4 nested collections; 2 things to finish.` - whose single action opens the collection on its Info tab when there is a report (the environment outcome of #2115 then rides in the message alone, see `import-environment.ts`), and otherwise is the environment outcome's own action if it has one; the Info-tab open works even from another sub-tab of the same collection (`CollectionDetail` reads `tab-selection-store` for the selected collection rather than only seeding from it)

## `import-environment.ts`

The active environment after an import (issue #2115): `planEnvironmentActivation` decides from the environments the batch created and the engine's list, `activateImportedEnvironment` carries it out and returns the outcome `announceImport` folds into the toast (`; "Staging" is now the active environment`).
The outcome's action - **Use "Staging"**, or **Choose environment**, which opens the title bar menu through `env-switcher-store` - takes the toast's single action slot unless **Review import notes** holds it

## `tree-utils.ts`

Every `parentId` walk in the renderer: `walkAncestors` (the ancestor chain, root first), `collectionPath` (the "Payments / Auth" label the palette and the new-request picker show), `isDescendant`, `collectDescendantEntityIds` (what a cascade delete reaches), `countSubtreeRequests` (the requests anywhere under a folder, which a root row's count shows).
Each carries a visited-set termination guard - the engine tolerates cycles in stored data, and an unguarded walk hangs the window rather than answering wrongly.
Also used by `queries/collections.ts` and `useVariableResolver`

## `tree-children.ts`

`childrenOf(parentId, ...)`: a parent's sub-folders and requests as the one list the tree shows them in, sorted by `compareTreeOrder` with each row's kind stated (#2535).
The top level holds collections only.
`mergeSiblings(folders, requests)` is the merge itself, for a caller that already holds both lists: `flattenVisibleRows` indexes the folders by parent once per build rather than filtering the whole list per expanded folder.
The render, the drag, Alt+Arrow, the menu's Move up / Move down gating, "Move to…" and the reorder mutation's optimistic renumber all read one of the two, so none merges the two kinds itself

## `drop-position.ts`

Where a drop lands: 25/50/25 bands on a folder row, 50/50 on a request row, resolved to a parent plus an anchor row.
A parent's children are one list, so a request lands between two folders and a folder beside a request; the one refusal by kind is a request on a root folder's edge band, since the top level holds collections only.
Returns a parent + anchor, never a pixel position

## `reorder-math.ts`

The arithmetic behind a drop: `planMove` turns a parent's merged sibling list and a target index into the `POST /reorder` batch, writing only the rows whose position changes - each as its own kind - and normalizing (`{ parentId }`) a parent whose rows are not dense.
Pure and node-tested - the part of a drag a jsdom gesture cannot reach.
Consumed by `useReorderMutation`

## `CollectionDetail/` (screen `"collection-detail"`)

Tab shell reached via `navigationStore.navigateToCollection(id)`. Header shows name + request count, and - right-aligned - the mock-server control; six tabs:

The **request count is the whole subtree**, not the requests the collection owns
directly, and the shell computes it once for both the header and the Info tab. A
spec-bound root usually owns none directly - an OpenAPI import files them under
one sub-collection per tag - and every other surface on this screen already means
the subtree: the mock serves it, the Run dialog runs it, the export walks it, the
Spec tab counts it.

| Tab | Component | Notes |
|---|---|---|
| Info | `InfoTab.tsx` | Name, description, request count (the shell's subtree count, handed down). [Details](#info-tab-infotabtsx) |
| Auth | `AuthTab.tsx` | Collection-level auth (concrete; never `inherit`). [Details](#auth-tab-authtabtsx) |
| Elements | `ElementsTab.tsx` | Extractors, assertions, timers and scripts on the collection, through the shared `ElementList` primitive (issue #1512). [Details](#elements-tab-elementstabtsx) |
| Variables | `VariablesTab.tsx` | Collection-scoped variables (count badge) |
| Data | `DataTab.tsx` | The declared **data contract** (issue #599): pick a file and its columns are declared onto `collection.dataSchema`. [Details](#data-tab-datatabtsx) |
| Spec | `SpecTab.tsx` | The bound **OpenAPI document** (issue #638): where it came from, when it was bound, and how many requests carry an operation. [Details](#spec-tab-spectabtsx) |

`MockServerControl.tsx` is the header's right-hand control and the only surface that can **start** a
mock server (issue #481 phase 2), because it is the only one holding a collection. With none running
for this collection it is a **Run mock server** button; with one running it is a chip carrying the
base URL, the route count and how many of those routes have no example, plus copy, an **Open mock
server** link to the `mock-server` tab and stop. It picks
its mock by `collectionId` and, when several match, by the **lowest port** - nothing stops a user
starting two mocks of one collection, and the engine's list order is not stable across polls. There
is deliberately no restart: a mock's route table is a start-time snapshot, so stop-and-start is the
only way to pick up an edit, and the stop tooltip says so.

Beside the button, not in front of it, is a **Mock server options** control opening
`StartMockServerDialog.tsx` - the start form for `latencyMs` and `errorRatePct` (issue #570). The
split is the point: the common case is "serve this collection with nothing set" and stays one click,
while the two knobs matter to the load run you point at a mock rather than to poking a route by
hand. A dialog on the way in would charge the common case for the uncommon one;
[`NewIssuerDialog`](services.md#services-modulesservices) has no equivalent split because an issuer has no
defaults-only case worth one click. The bounds (`0-30000ms`, `0-100%`) live in
`mock-server-options.ts` mirroring `constants::mock_server::`, and the form refuses an out-of-range
or emptied value **with the range in words** - the engine's `400` names the field and not the bound.
The same dialog carries the **Allowed origins** box (issue #2367, `AllowedOriginsField`), sent only
when something is listed.
The mutation stays in `MockServerControl` and the dialog reports its failure as a `Callout` instead
of a toast behind an open form; opening the dialog resets it, so a failed one-click start does not
greet the next open. Neither knob is mutable on a running mock: they are read per response and so
*could* be, but a run against a mock has to be able to say which configuration produced its numbers
- the same reason the route table is frozen - so there is no `PUT /mock/:id` and the stop tooltip
names all three as start-time.

`InheritanceChain.tsx` and `shared.tsx` are helpers used by these tabs (e.g. visualizing the auth/variable inheritance chain); `format.ts` holds the relative-timestamp helper, kept out of `shared.tsx` so a file of components exports nothing else (fast refresh). `collection-drafts.ts` defines what each draft tab (Info, Auth, Elements) edits, read from the collection, and builds the stored draft its save context reads against the collections list once the tab is gone (#3459); those three tabs are keyed by collection id, so a collection switched away from keeps saving through its own mutation observer rather than the next collection's. `AuthTab` passes it the tab's own live draft (`draftAuth`), so the chain shows the picked-but-unsaved mode instead of the stored one while the picker is dirty (#1483) - the same draft `CollectionAuthSection` above reads through `useCollectionAuthDraft`. This collection's row (and the No auth sentence, when it is the blocker) reads "(unsaved)" while the draft differs from the stored auth.

All five tabs hold their edits in a draft; four of them commit it without being asked. Info commits on blur (name) and on `onCommit` (description); both Script tabs commit when focus leaves the editor; Variables autosaves through `VariableTableEditor`. Info and the Script tabs take the draft, the resync and the mutation reset from [`useEntityDraft()`](../state-management/draft-hooks.md#useentitydraft---manual-draftsave-model) and render no Save button at all - the hook owns the mutation reset on a collection switch, which had been hand-rolled per tab with one tab omitting it.

**A dirty draft can show "Changed elsewhere" instead of losing an edit (#1437).** An MCP agent's `update_collection` landing while Info, a Script tab or Auth is mid-edit no longer overwrites the unsaved text: the shared [`ExternalChangeCallout`](shared-fields.md#shared-external-change-callout-componentssharedexternalchangecallouttsx) renders the notice with a "Take theirs" action, driven by `useEntityDraft`'s `externalValue`. Auth and the Script tabs treat their draft as one value, so the whole tab shows one callout wired to `reset()`. Info's draft is `{name, description}`, so it merges per field instead - a field the user has not touched adopts the agent's change immediately, and only a field both sides touched shows its own callout. Its Take theirs calls `adopt`, so taking the value is a discard the Dock reports as idle, not "Saved" (#2033).

Info's blank-name rule survives the buttons' removal by being spoken instead: the tab puts the stored name back and `reportBlankNameRefused()` (`lib/blank-name.ts`) says so in a toast, the same wording the request builder's Info tab uses. It is not reported to the save store: with the stored name back nothing is unsaved, so the Dock has no "Not saved" to show. The Script tabs' `Clear` writes on the press rather than waiting for a blur that is not coming - focus lands on the button, not in the editor.

**Auth is the exception, and it is a decision (#446), not a leftover.** Not because a credential outranks a script - the request builder autosaves its own auth - but because a blur inside `AuthFields` is not a completion signal. Measured on this tab: an OAuth 2.0 config with Advanced open renders 20 focus stops, 9 of them non-value controls (the grant-type and Add-to pickers, three switches, the secret reveal toggle, the Advanced disclosure, Get Token), and clicking reveal to check a half-typed password fires `focusout` while the draft is dirty. The fields only make sense written together, which is what the button means. A script tab has exactly one focus stop. Because the tab therefore differs from its neighbours, it states its save model above the fields rather than only through a button further down the page. If collection auth is ever to persist by itself, the mechanism is `useSaveManager`'s debounce, not a blur.

### Info tab (`InfoTab.tsx`)

Name, description, request count (the shell's subtree count, handed down).
**Autosaves** - no Save/Cancel.
Opens with `ImportNotesCallout.tsx` when an import recorded a report for this collection (issue #2109): the preview's notice lines and file-reference list from `import-report-store`, with a dismiss button; nothing otherwise

### Auth tab (`AuthTab.tsx`)

Collection-level auth (concrete; never `inherit`).
Mode picker + hints only - the fields are the shared [`AuthFields`](shared-response-viewer.md#shared-auth-fields-componentssharedauthfields).
**The one tab with a Save button**, and it says so above the fields

### Elements tab (`ElementsTab.tsx`)

Extractors, assertions, timers and scripts on the collection, through the shared [`ElementList`](shared-element-list.md#shared-elementlist-componentssharedelementlist) primitive (issue #1512).
Replaces the Pre-request and Post-request tabs - a script is now a `script.pre` / `script.post` element like any other kind, edited by the same list.
**The one other tab with a Save button** beside Auth, and for the same reason (#446): adding a kind, naming a row, toggling it, reordering it and editing its form are all separate focus stops, not one buffer a blur can commit.
It passes the collection's `VariableSupport` to the list, so the fields the engine resolves `{{tokens}}` in are variable-aware (#3779)

### Data tab (`DataTab.tsx`)

The declared **data contract** (issue #599): pick a file and its columns are declared onto `collection.dataSchema`, **Remove** clears the contract (the picker's `onRemove`, distinct from a refused pick's `onSelect(null)`), **Re-declare** / **Clear** cover drift, a failed save and a vanished file, plus the **referenced-columns audit** (`ColumnAudit.tsx`, issue #600).
Declared-column count badge.
Writes per gesture, through the shared `hooks/useDataContractWriter.ts` (declare and clear; the file's path is written in the same update as the schema, so the engine takes both or neither), so it holds no draft and is absent from `TABS_HOLDING_DRAFTS`

### Spec tab (`SpecTab.tsx`)

The bound **OpenAPI document** (issue #638): where it came from, its short hash, when it was fetched and bound, and how many of the subtree's requests carry an operation identity.
Binds a collection that was not imported from a spec - match by method and path shape, counts disclosed, matches stamped and nothing else touched - **Unbind** sends `openapi: null`, and the **Export** menu opens either export dialog - **OpenAPI…** (issue #630) or **Postman Collection v2.1…**.
The **Sync** section (`SpecSync.tsx`, issues #654 and #655) re-reads the document from the URL or file the binding recorded, reports what moved in three buckets, and applies the items the user ticks in one engine call - checking still writes nothing, and a removal is never ticked for you.
Explicit per action, so it is absent from `TABS_HOLDING_DRAFTS` like Data
