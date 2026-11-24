---
description: >-
  TanStack Query as the source of truth for server state: the query hooks for collections, requests, environments, globals and runs.
---

# TanStack Query (Server State)

TanStack Query manages server state with automatic caching, refetching, and synchronization.
It is the source of truth for collections, requests, environments, globals, and runs.

## Query Hooks

Located in `app/src/queries/`, one file per resource family, all re-exported from `app/src/queries/index.ts`, which is what callers import from.
The key factory lives beside them in `app/src/queries/keys.ts`.
A couple of hooks with a single consumer are imported from their file directly (`useRunTimeSeriesQuery` from `@/queries/runs`); everything with more than one is in the barrel.

### Collections & Requests

- **`useCollectionsQuery()`** - Fetch all collections (there is no single-collection query: a collection is read out of this list)
- **`useCollectionName(collectionId)`** - A run's collection by name, read out of that list; the id stands in once the collection is deleted, never a blank
- **`useRequestsQuery(collectionId)`** - Fetch requests in a collection, as `RequestSummary` rows (`types/domain.ts`, #2546): `id`, `collectionId`, `name`, `method`, `url`, `order`, `createdAt` and `specOperation`, from `GET /requests?fields=summary` (`apiService.listRequestSummaries`).
  Every `listByCollection` cache holds that shape, and its type is what makes a reader that wants a body, headers, auth or scripts fail to compile rather than read `undefined`.
  `createdAt` is `compareTreeOrder`'s tie-break and `specOperation` the Spec tab's mapping count; the rest is what a tree row, the palette and "Copy for agent" draw.
  A write that already holds the whole row (a create, a reorder's settle) stores it as it stands, since a `Request` is a `RequestSummary`
- **`useMultipleCollectionRequests(collectionIds)`** - The same list for several collections at once, as parallel queries.
  Its `requestsByCollection` map is **referentially stable** while the underlying results are unchanged (built in `useQueries`' `combine`, which TanStack memoises only for a `combine` of stable identity - hence the `useCallback`).
  Callers list it in effect dependencies; when it was rebuilt on every call, the collection tree's reveal effect (`useRevealActiveSelection`) re-ran on every render and re-expanded a collection the user had just collapsed
- **`useFullCollectionRequests(collectionIds)`** - The same map over whole `Request` rows (`GET /requests?collectionId=`), for the column audit (`useColumnAudit`), which reads what each request sends.
  Mounted only by the audit's callers (the Data tab, the run dialog), so nothing fetches whole rows at launch.
  Its key, `requests.fullListByCollection(id)`, sits under that collection's `listByCollection` key, so every invalidation of the tree's list reaches it; a reorder therefore removes a moved request from *every* list its old collection has cached, not the first one a scan of `lists()` meets
- **`useRequestQuery(requestId)`** / **`requestDetailOptions(requestId)`** - One request by id (`GET /requests/:id`): what a request tab opens, what a restored tab and a design-run copy read on cold start, and what the tree's Duplicate copies (`queryClient.fetchQuery(requestDetailOptions(id))` in `useTreeCrud.ts`).
  Never seeded from a list row - a summary is not the request.
  The detail route also never substitutes a default for a column over the field cap, where a full list row can (`truncatedFields`, #1485), so a copy made from it is the whole request.
  Only an `ApiError` with `statusCode === 404` becomes **`RequestNotFoundError`** (test it with `isRequestNotFound`); a 5xx or an unreachable engine is rethrown untouched, because a transport failure must not read as "this request was deleted"
- **`useCollectionAncestors(collectionId)`** - The collection's ancestor chain including itself, root first, derived from the collections list rather than fetched
- **`usePrefetchCollectionsAndRequests()`** - Warm-cache pass over every collection's requests at startup: one `GET /requests?fields=summary` for the whole workspace (10.7 MB of whole rows on a 6,000-request workspace before #2546), split into each collection's `listByCollection` entry

**Sorting:** every tree list - roots, a collection's children, a collection's requests - sorts with the single exported `compareTreeOrder` (`types/domain.ts`): `order`, then kind (a sub-collection before a request), then `createdAt`, then `id` byte-wise.
There were two comparators with two different tie rules and neither matched the engine's, so "run this folder" could execute in an order the sidebar had never shown.
The rule is pinned to the engine's comparator (`engine/include/vayu/db/sibling_order.hpp`) by `engine/tests/fixtures/tree-order-conformance.json`, read by `types/tree-order.conformance.test.ts` and by the engine's `tree_order_test.cpp`
- change one side and the other suite fails.

A folder's sub-collections and its requests are **one list in one `order` space** (#2535), so a request can sit between two folders.
The kind is only a tiebreak, and only a merged list states it:
`childrenOf` (`modules/collections/tree-children.ts`) builds a parent's children from the collections list and the parent's request list, `flattenVisibleRows` lists each expanded folder's children through the same merge (`mergeSiblings`), and the drag, the keyboard move and "Move to…" all read that one list (`CollectionTree.sibling-order.test.tsx`).
A recursive collection run executes the same sequence - a request where it sits, a sub-folder's whole subtree where the sub-folder sits -
which is pinned across the render and the engine's plan by `engine/tests/fixtures/recursive-run-order-conformance.json`, read by `modules/collections/CollectionTree.run-order.conformance.test.tsx` and by the engine's `scenario_plan_test.cpp` (issues #431, #2535).

**Mutations:**
- **`useCreateCollectionMutation()`** - Create collection: appends the row to the collections list and seeds the new collection's request list with `[]`, so the tree mounting it makes no list call and no other list refetches
- **`useUpdateCollectionMutation()`** - Update collection (with cache update, `storeUpdatedCollection`).
  An update carrying `specFile` / `dataFile` goes through `writeFileBinding`, behind the collection's earlier binding writes.
  Invalidates every cached composition unless the update carries only `specFile` / `dataFile`, which nothing composes against (#2765)
- **`useDataFileReadingMutation()`** - Change how a bound data file is read (`castNumbers`, #2540) through `rememberDataFileReading`, the binding built when the write is sent
- **`useDeleteCollectionMutation()`** - Soft-delete a collection into the trash rather than removing it (issue #988);
  invalidates coarsely, see below, and also invalidates the trash list so the Trash view picks it up, and the running-mock list (`mockServer.list()`): the engine stops the mocks of the subtree as part of the delete, whichever client sent it (#3449), so the app sends no stop of its own and only refreshes what it shows.
  It writes no file binding: the spec-file and data-file bindings stay on the trashed row (#2765), the stores that mirror the list drop the entry with the row, and the tree's Undo - a restore - brings them back with nothing captured client-side (`captureClientState` in `useTreeCrud.ts` keeps only the focused tab).
  Every mutation that invalidates **all** the request lists does it through `invalidateAllRequestLists` (`queries/collections.ts`): `prefetch.allRequests()` *before* `requests.all`, so the per-collection lists that refetch join the one `GET /requests?fields=summary` instead of each making a call of their own.
  It is used by this mutation, `useImportMutation`, `useBindSpecMutation`, `useSyncSpecMutation`, `useRestoreTrashMutation` and the MCP `collection` family
- **`useCreateRequestMutation()`** - Create request: appends the engine's row to the tree's list, to the whole-row list only where one is cached, and writes its detail
- **`useUpdateRequestMutation()`** - Update request (invalidates only the lists that can have changed, see below)
- **`useDeleteRequestMutation()`** - Soft-delete a request into the trash (also clears the response, and invalidates the trash list).
  Refetches only the owner's list, read from the request's cached detail before it is removed and from the list caches failing that; with no owner known it falls back to `invalidateAllRequestLists`
- **`useReorderMutation()`** - Reposition collections and requests through `POST /reorder` in one transaction, optimistically (see below)
- **`useImportMutation()`** (`queries/import.ts`) - Apply a parsed import through `POST /import/apply` in one transaction.
  Resolves with `{ idMap, rootIds }`: the engine's temp-id map, plus each root collection's temp id mapped to its real id, which is what lets the caller expand and open what it created

**Reordering (`useReorderMutation`)** is the one mutation that writes its caches three times, because a drag is only believable if the row is where the pointer left it before the write returns:

- `onMutate` snapshots every key the plan can touch and *draws the plan* into the caches - the same two steps the engine performs, normalize each named parent to `0..n-1` in sibling order, then position each move.
  A normalized parent spans **two** caches, its sub-collections in the collections list and its requests in its own list, renumbered as one run; both are snapshotted.
  A cross-collection move crosses list caches and updates `requests.detail` (which carries `staleTime: Infinity`, so a stale `collectionId` there would outlive every refetch).
- `onSuccess` re-applies the rows the engine actually wrote, which the response carries.
  They are normally what was drawn, but a normalization is authoritative from the engine, so the tree settles on real positions rather than a guess.
- `onError` restores the snapshots wholesale and reports through `useToastStore.showToast`, not `reportFailed`: the drop is rolled back, so no edit is unsaved, and `reportFailed` would park the Dock on "Not saved" with nothing pending (a failure that is not an unsaved edit raises its own toast, per `save-store.ts`).
  The mutation owns this rather than its caller, so the gesture layer cannot forget it.
- `onSettled` invalidates the affected keys **once** - the collections list only if a collection moved or a parent was normalized, and only the request lists the plan named or normalized.

Every write goes through `setQueryData` with a fresh array, never a mutation in place: the map `useMultipleCollectionRequests` builds is compared by reference by the reveal effect, so an in-place edit would move a row on screen that the tree never notices.
The plan itself comes from `modules/collections/reorder-math.ts` - a pure module, node-tested, that turns a parent's merged sibling list and a drop index into the minimal set of rows to rewrite, each written as the kind it is.

### Trash

The read side of the same soft delete (issue #989): `useDeleteCollectionMutation`, `useDeleteRequestMutation`, `useDeleteEnvironmentMutation` (#2970), `useDeleteRequestExampleMutation` (#2971, for a saved example) and `useDeleteClientCertificateMutation` (#2973) stamp a row rather than removing it, and these are how the app sees what got stamped (`queries/trash.ts`).

- **`useTrashQuery()`** - Every deleted root, newest first (`GET /trash`).
  No `staleTime`: the list changes only through the two mutations below, the five delete mutations, and the startup retention purge, so the default is already the cheapest correct answer.
- **`useRestoreTrashMutation()`** - Put one deleted root back (`POST /trash/:id/restore`).
  Invalidates `trash.all`, `collections.all` and every request list through `invalidateAllRequestLists` - the same coarse invalidation `useDeleteCollectionMutation` does, and for the same reason (see the cascade delete note below) - plus `environments.all` and every composition (`invalidateCompositions`) and `clientCertificates.all`, whatever kind came back:
  a restored environment reappears in the Variables tree and its variables can resolve again, and a restored client certificate reappears in the Settings card (and is presented to its host again on the next send).
  A restore the engine refuses with a 409 - a live certificate has since claimed the same host and port - shows the engine's message, from the Trash view's Restore and from the delete toast's Undo alike.
  A restored example reappears in its request's Examples panel through the same `requests.all` invalidation: `requests.examples(id)` sits under it.
  It leaves `activeEnvironmentId` alone (see the session store above).
- **`usePurgeTrashMutation()`** - Destroy one deleted root for good (`DELETE /trash/:id`).
  Invalidates only `trash.all`: every other cache already stopped serving these rows when they were stamped, so purging them changes nothing a live read can see.
  The purged collection's file bindings go with its row, engine-side (#2765); nothing here holds a copy to clear.

Both mutations also invalidate `trash.all` on **failure** (#1438).
The row either acted on is one this list said existed, so the likeliest failure is that it no longer does - an agent's `purge_trash_entry` or `restore_trash_entry` landed between the drawer's last read and the click.
Leaving the list alone there keeps a phantom row on screen that fails the same way on every further click; refetching either removes it or proves it real.

### Environments & Variables

- **`useEnvironmentsQuery()`** - Fetch all environments
- **`useGlobalsQuery()`** - Fetch global variables
- **`useCookiesQuery()`** / **`useClearCookiesMutation()`** (`queries/cookies.ts`) - The engine's cookie jars, one per environment, read and cleared by `CookiesCard` in Settings.
  The mutation invalidates rather than patching the cache: a clear that raced a request in flight would otherwise leave the panel claiming an empty jar the engine has already refilled
- **`useClientCertificatesQuery()`** and the create / update / delete mutations (`queries/client-certificates.ts`) - the engine's host-to-certificate registry for mTLS endpoints (issue #707), read and edited by `ClientCertificatesCard` in Settings > Network & connectivity.
  The list's rows carry `usable` and, when false, `problem` (#3260): whether the engine would present the entry against the files as they are now, which only the list answers.
  The mutations invalidate rather than patching: the engine refuses a second entry for a host+port pair already taken, so the list is the authority on what a new entry may claim.
  The delete is soft (#2973): it also invalidates `trash.all`, the card raises the shared "Moved to the Trash" toast with Undo through `useTrashUndo` (kind `clientCertificate`, read aloud as "client certificate"), and the Trash lists the entry by its target, `host` or `host:port`
- **`useFileRootsQuery()`**, **`useAllowChosenFolderMutation()`** and **`useDeleteFileRootMutation()`** (`queries/file-roots.ts`) - the folders a request-body file may be sent from without a per-file pick, read by Settings > Files, the binary body editor and the import preview.
  The list is a plain `GET`; both writes go through the main process, which holds the engine's grant secret (#2356): the allow mutation takes no argument - neither a folder nor a title nor where the picker opens (#2378) - and resolves with the engine's answer (`cancelled` included).
  An allow that lands invalidates rather than appending: the engine stores the canonical path, which can differ from the one picked

**Mutations:**
- **`useCreateEnvironmentMutation()`**
- **`useUpdateEnvironmentMutation()`**
- **`useSetActiveEnvironmentMutation()`** - The only writer of the active environment; PUTs `isActive` and mirrors it into `session-store`, rolling the store back if the engine refuses
- **`useDeleteEnvironmentMutation()`** - A soft delete into the Trash (#2970).
  Patches the environment out of the list cache, removes its detail cache, clears `activeEnvironmentId` when it was the active one, and invalidates `trash.all` so an open Trash view lists it
- **`useUpdateGlobalsMutation()`**

### Runs & History

- **`useRunsQuery(q?, pinnedOnly?, origin?, type?, status?, outcome?)`** - Run history as an **infinite query** over the paginated `GET /runs` `{data, pagination}` envelope, newest first.
  `fetchNextPage` pages older runs in on demand, by **keyset cursor** (#2978): the first page carries no cursor, and each next page is asked for `before=<the previous page's pagination.nextBefore>`, the engine's own value rather than one derived from the rows, with no `offset`.
  A cursor page costs the same at any depth and does not shift when a run starts between two pages; `nextBefore: null` ends the paging.
  `q` is the optional server-side search; `origin` (`"app"` or `"mcp"`, `undefined` for all) is `GET /runs?origin=`, and `outcome` (`"passed"`, `"failed"` or `"not_judged"`, #3547) is `GET /runs?outcome=`; the engine stores `failed` for every failed run, but not for one stored before the column (#3643).
  `type`, `status` and `outcome` join the query key only when set, so the unfiltered list keeps its entry.
  - **Polling is gated to the unpaged state** (`runsPollInterval`): 5s while only page 1 is loaded, **off** once the user has paged older runs in.
    Refetching an infinite query re-fetches *every* loaded page in sequence, so a user ten pages deep drove ~10 engine requests per tick.
    Only page 1 can gain rows (`start_time DESC`) anyway; a paged list refreshes on the next mutation or invalidation instead of on a timer.
  - **Only a surface that renders runs mounts it.**
    The interval belongs to the hook, so it runs for as long as *any* observer is mounted - and the App root used to be one, which kept the poll alive with History closed, nothing running and nothing at the root reading the result (#1150).
    The root now calls **`usePrefetchRuns()`** instead: one `prefetchInfiniteQuery` over `runsListInfiniteOptions()`, which warms the same cache entry without observing it.
    `HistoryList`, `WelcomeScreen` and the palette's `useEntityItems` observe the key while they are visible and drive the cadence themselves.
  - **`runsListInfiniteOptions(q?, pinnedOnly?, origin?)`** - the key, fetcher and page params (the cursor, `string | undefined`), shared by the hook and the warm-up so the entry one writes is the entry the other reads.
    `origin` joins the key only when set, so the unfiltered list stays the entry the warm-up and the other observers share.
    `prefetchInfiniteQuery`, not `prefetchQuery`: the readers are infinite queries and the cache entry has to be in `InfiniteData` shape.
  - **`flattenRunPages(data)`** - flatten the pages into a de-duped `Run[]` (a refetch walks the pages in order and reads each cursor off the page it just fetched, so pages abut and a run cannot sit in two; dedupe by id is the cheap guard that keeps a doubled row out regardless).
    **`runsTotal(data)`** - the server's total from the first page.
- **`useRunsCountQuery()`** - How many runs are stored, for Settings' "N stored runs": one `limit=1` read of the list envelope, answering its `pagination.total`, so opening Settings costs one request and one row however long the history is (#2979).
  Not polled.
  *Clear run history* does not read rows either: when it is pressed it asks `limit=1` counts for the pinned baselines and the running / pending runs (`baseline=true`, and `baseline=false` with each `status`), which is all its dialog needs to say what goes and what is kept.
  The `count()` key sits outside `runs.lists()`, because it caches a bare number and the delete patch walks that prefix as `InfiniteData`.
- **`useLastDesignRunQuery(requestId)`** - The most recent completed design run for a request, in **one** filtered call (`?requestId=&type=design&status=completed&limit=1`) - the server sorts `start_time DESC`, so its single row is the answer.
  No client-side download-and-filter.
  It caches a **plain `RunListResponse`**, so it has its own key family (`queryKeys.runs.lastDesign(requestId)`) and deliberately does **not** sit under `runs.lists()`: `RequestBuilderProvider` mounts it for every open request tab, and the delete-run patch walks that prefix as `InfiniteData`.
  Keeping the two shapes apart at the root is the rule - a prefix patch must never meet a cache shape it did not write.
  Under the `lastDesigns()` prefix, like the three families below it, so a delete, a cleared history or an MCP `run` event reaches it without knowing which request it belonged to (#776): a run id gives no way back to one, and until the prefix existed a deleted design run went on being restored into the tab that had it open.
- **`useRecentDesignRunsQuery(requestId)`** - The last `RECENT_DESIGN_RUN_LIMIT` (5) design runs of a request, newest first, behind the context bar's **Recent sends** section.
  One filtered call (`?requestId=&type=design&limit=5`) and **no report fetch**: each row carries its own `resultSummary` (`statusCode` + `latencyMs`) from the engine, and the report path would load and JSON-parse every result's `trace_data`, per row.
  Deliberately **unfiltered by status**, unlike `useLastDesignRunQuery` - `status` takes one value, so filtering to `completed` would hide every failed send, which is most of what a trend is read for.
  Own key family (`queryKeys.runs.recentDesign(requestId)`) under the `recentDesigns()` prefix, outside `runs.lists()`, for the same shape reason as `lastDesign`.
  Not polled: the builder's send path, `DesignRunView`'s replay, the MCP `run` event, `useDeleteRunMutation` and `useInvalidateRuns` (Settings' *Clear run history*) each invalidate it, and a new run-writing path has to as well or the section keeps showing the sends from before it.
- **`useLastCollectionRunQuery(collectionId)`** - The most recent run of one collection, behind the context bar's **Last run** section.
  One filtered call (`?collectionId=&limit=1`) over the engine's `collectionId` filter, which matches a scenario snapshot's own `scenario.collectionId` as JSON rather than its text - the lookup that did not exist, which is why the section was deferred twice (#377 → PR #394 → PR #400 → #422).
  Unfiltered by status for the same reason `useRecentDesignRunsQuery` is: a failed run is the one worth surfacing.
  Own key family (`queryKeys.runs.lastCollectionRun(collectionId)`) under the `lastCollectionRuns()` prefix, outside `runs.lists()`, for the third time and the same shape reason.
  Invalidated by `useStartScenarioRunMutation` (the new run *is* the last run), `useDeleteRunMutation` and `useInvalidateRuns`.
- **`useRunQuery(runId)`** / **`runDetailOptions(runId)`** - Fetch a single run (full `configSnapshot`).
  Same 404 contract as `requestDetailOptions`: only an `ApiError` with `statusCode === 404` becomes **`RunNotFoundError`** (test it with `isRunNotFound`, never by message), and that error is **never retried** - a run tab is persisted and outlives its run, so a deleted run used to retry forever behind a "Try again" that could not work.
  Everything else - a 5xx, an unreachable engine - is rethrown untouched and keeps the default retry budget.
  `HistoryDetail` renders the two cases differently: "this run no longer exists" (deleted, or removed by History's retention, which keeps only the newest Send runs; the 404 cannot tell them apart) with **Close tab**, versus "couldn't load this run" with **Try again**.
  The options carry a function-form `refetchInterval` that polls (3s) only while the cached run's status is `running` or `pending`: this object is spread into every open tab's query by `tab-descriptors`, and a run opened mid-run (from another window, an agent or a relaunch) has nothing else that tells it the run ended (#1934).
- **`useRunReportQuery(runId, status?)`** - Fetch a run's report.
  The engine answers the report endpoint for a live run too, so a copy is final only when the run is.
  Pass the run's `status` when it is known: `running` or `pending` (`isRunInProgress`, `lib/run-status.ts`) makes the report `staleTime: 0` and re-read every 3s; any other status, or none, keeps `RUNS_STALE_TIME_MS` and no timer.
  Also written by `LoadTestService` at stream end via `queryClient.fetchQuery` with `staleTime: 0` - the one fetch that knows the data just changed, so it must not resolve from a mid-run copy a History tab cached (#1934).
  The service then invalidates `runs.detail`, `runs.report`, `runs.timeSeries` and `runs.monitorSeries` for the run, so a mounted tab refetches in place and one opened later finds stale entries.
  A stream that dropped while the run was still going invalidates the report alone: nothing ended, so the status and series are still current.

- **`useRunTimeSeriesQuery(runId, status?)`** (`@/queries/runs`) - The stored series behind the History charts, in **one request**: `GET /runs/:id/metrics?maxPoints=HISTORY_SERIES_MAX_POINTS` (2,000, `config/network.ts`).
  A run with at most that many ticks comes back raw; a longer one comes back folded into buckets, with `bucketed: true` and `ticksPerBucket` on the envelope (#2547), which the Performance tab's charts state in a note.
  It is a plain query, never paged: a 24 h soak used to be 18 pages of raw ticks.
  Keyed `runs.timeSeriesDownsampled(id, maxPoints)`, under the `runs.timeSeries(id)` prefix the run-scoped invalidation and removal use.
  A finished run's ticks cannot change, so `staleTime: Infinity`; with an in-progress `status` the ticks written so far are stale at once.
  `gcTime` is the short `RUN_SERIES_GC_TIME_MS` (1m): the entry is small and one request to read again.
  Not polled; the live ticks have the dashboard's stream.
- **`useRunMonitorSeriesQuery(runId, enabled, status?)`** (`@/queries/runs`) - The server vitals scraped during the run, in **one request** the same way: `GET /runs/:id/monitor?maxPoints=HISTORY_SERIES_MAX_POINTS` (#2611).
  A run with at most 2,000 scrapes comes back raw; a longer one is folded into buckets (each series the bucket's max, the timestamp its last scrape's) with `bucketed: true` and `ticksPerBucket`, which the Server vitals card states in its own note, apart from the tick series' note.
  A plain query keyed `runs.monitorSeriesDownsampled(id, maxPoints)`, under the `runs.monitorSeries(id)` prefix the run-scoped invalidation and removal use, with the time series' staleness and `RUN_SERIES_GC_TIME_MS`.
  `enabled` is the report's `monitor.samples > 0`, so a run that scraped nothing issues no request.
  A failed read is a `monitorFailure` whose Try again refetches it; nothing requests it again on its own.

**Mutations:**
- **Stopping a run is not a mutation hook.**
  It is `useEngine().stopLoadTest(runId)`, which calls `apiService.stopRun` and returns a boolean rather than throwing - the dashboard's Stop button reports the refusal itself.
- **`useDeleteRunMutation()`** - Delete a run.
  Patches every infinite-list cache variant in place (drops the row, decrements the mirrored `total`), invalidates the stored-run count, and evicts the run's report.
  The list updater shape-guards (`!Array.isArray(old.pages)`) as a belt to `lastDesign`'s braces.
  The `recentDesigns()` and `lastCollectionRuns()` families are **invalidated rather than patched**: a deleted run gives no way back to the request or collection their sections are keyed by, and refetching a few rows beats carrying a run-to-owner map to patch them.

**Deleting a run closes its tabs.**
Both delete flows - `HistoryList`'s row delete and Settings' *Clear run history* - call `closeTabsForEntities(ids, "run")` for the runs the engine actually removed.
For the row delete that is the run it named, unless the call was refused (a 409'd run keeps its tab, because the run is still there); for *Clear run history* it is the `deletedIds` that `DELETE /runs` answers with, so a pinned baseline or a run still in flight keeps its tab (#2429).
Tabs are persisted, so a run tab left open after its run is gone is not merely stale: it rehydrates into a pane that can never load on every restart.

### Engine Health, Config & OAuth

- **`useHealthQuery()`** - Health check, polled every `TIMING.HEALTH_CHECK_INTERVAL_MS`; it is what sets `engineStatus` / `engineError` on `engine-store`, and is where the starting-vs-unreachable decision gets made, so the connection indicator follows it.
  It reads that decision off `engineStartWindow`, which `useEngineRestart` also opens - the restart supplies the evidence, the poll still does the classifying
- **`useConfigQuery()`** / **`useUpdateConfigMutation()`** - Engine configuration (`QUERY_CACHE.CONFIG_STALE_TIME_MS`); also the home of the live chart window, which is engine config rather than a renderer preference
- **`useScriptCompletionsQuery()`** / **`useScriptTypeDefinitionsQuery()`** - the `pm.*` completion list and the engine-generated `.d.ts` behind Monaco's hover text and diagnostics.
  Both derive from one engine-side table that changes only with the engine binary, so both take `QUERY_CACHE.SCRIPT_COMPLETIONS_STALE_TIME_MS` and the same gc time; the type definitions also cap retries at `SCRIPT_COMPLETIONS_RETRY`, since losing them costs hover text rather than the editor
- **`useOAuth2TokenStatusQuery(cacheKey)`**, **`useFetchOAuth2TokenMutation()`**, **`useClearOAuth2TokenMutation()`** - the engine-side OAuth 2.0 token cache
- **`useOAuth2StepUpQuery(input)`** (`queryKeys.oauth.stepUp(wwwAuthenticate, scope)`) - `POST /oauth2/step-up` for a 403's challenge (#3766), asked by the response pane's step-up callout.
  The engine only classifies, so the answer is a function of the key: `staleTime: Infinity`, no poll, disabled for a `null` input.
  Under `oauth.all`, so the MCP feed's OAuth invalidation refetches a mounted one, which answers the same
- **`queryKeys.compose.forRequest(requestId, environmentId, source)`** - `POST /compose` for a request, behind `compositionOptions` (`code-composition.ts`), which the context bar's Code section, the Params tab's "Sends" line and the tab strip all build their query from, so they share one entry (#2741).
  The Code section fetches it on expand.
  The Sends line fetches it only for a URL, path row or query-placed API key or OAuth 2.0 token name, or GraphQL GET document, holding a `{{token}}` (default mount behaviour, so a tab switch back is a cache hit), for the `deferredVariables` it needs.
  `RequestBuilderProvider` reads it too, once per builder and only while the request holds a `{{token}}` anywhere (`requestHasTokens`), so the token painters can leave those names unpainted as resolved.
  A builder holding such a request therefore asks `/compose` when it opens and again after each invalidation (every autosave), where before only an open Code section did - a deliberate cost of painting deferred tokens (#2741).
  The strip only reads it: a disabled observer per request tab, editor entry first, never a fetch.
  Keyed by environment as well as request, because the same request composes differently per environment and one key for both would serve the wrong snippet after a switch.
  `source` is `"editor"` while the mounted request builder publishes that request's draft (the `editorDraft` live surface, #2638) and `"saved"` otherwise:
  the query function composes the draft inline through `buildComposeBody`, as Send does, or the stored row by id, so a builder taking the request on is a new key and a fresh compose rather than the saved row's answer kept under `staleTime: Infinity`.
  The draft is read when the query runs, never subscribed, so the key does not move per keystroke; the autosave PUT's invalidation below reruns the same function, which reads the draft again.
  `staleTime: Infinity` with an explicit recompose: the section is only mounted while expanded, so this is the "compose on expand, not per keystroke" rule.
  The section also ships collapsed by default (`CONTEXT_BAR_DEFAULT_COLLAPSED`), so that round trip now happens on first expansion rather than on every request tab opened (#1310).
  `queryKeys.compose.allForRequest(requestId)` is the per-request invalidation root, and `forRequest` is built from it rather than beside it so the prefix relationship holds by construction - that is the key a write to one request drops, the renderer's own PUT (`useUpdateRequestMutation`) and an MCP one alike (#1438, #1877).
  Both reach it through one helper, `invalidateCompositions(queryClient, requestId?)` in `queries/compose-invalidation.ts`, the only place outside `keys.ts` that names a compose key; without a `requestId` it drops `compose.all`, which is what the environment, globals and collection PUTs and their MCP counterparts take.
  `staleTime: Infinity` does not stand in its way: it gates the *cost* of composing, not the correctness, because `invalidateQueries` refetches a mounted observer whatever its `staleTime`
