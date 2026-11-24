---
description: >-
  Worked state flows - a single request, a load test run, an auto-save, variable resolution priority - and the practices for state code.
---

# State flow examples and best practices

## State Flow Examples

### Executing a Single Request

1. User clicks "Send" button in request builder
2. `useEngine().executeRequest()` is called with request and (optionally) environment ID
3. `useVariableResolver()` resolves any `{{variables}}` in the request URL, headers, body
4. Request is transformed (frontend → backend format) and sent via HTTP
5. Response is stored in `useResponseStore()` keyed by request ID
6. Response viewer component reads the response and displays it
7. On **request tab switch**, the response persists in `response-store` and is displayed if the user returns - for the most recently sent requests (at most 24, fewer when their bodies are large - see the byte budget), past which the store's LRU bound has dropped the entry and the backend's stored run answers instead
8. If any script ran, the environment / globals / collection query families are invalidated so values the script wrote are visible in the variables editor and the resolver.
   The gate is `scriptsMayWriteVariables(pre, post)` (`request-builder/utils/execute-mapping.ts`), shared by the builder's send path and the History run view's resend.
   **Both** script kinds count: `pm.environment.set` and friends persist engine-side from a Tests-tab script exactly as from a pre-request one, and with `refetchOnWindowFocus: false` nothing else is coming to correct a stale value

### Starting a Load Test Run

**One live run owns the live view at a time** (#3351, #3381).
`canStartLoadRun()` in `stores/run-gate.ts` is the one answer (the names say "load run" from before it covered both kinds), read by every place a run starts: the request builder (before its dialog opens, and again at Start), the Run Collection dialog in either mode, and `useRunWatchers` for an agent's run.
It refuses while the dashboard's run is live (`isDashboardRunLive`, so a lost stream counts) or a collection run is streaming, because `sseClient` holds one `EventSource` and any run attaching would take it from either.
The engine sets no limit of its own; this is renderer policy.
The answer names the running run (`{ kind: "load" | "collection", runId, label }`, the label being the dashboard's method and URL when it holds them), and `runningRunSentence` / `runningRunTab` turn that into the refusal and the tab that shows the run.
The builder opens that tab with a warning toast; the dialog shows a blocking callout with View run and **Stop**, and keeps Run disabled, following the gate through `useCanStartLoadRun()` so Run comes back when the run ends.
Stop is `useStopLiveRun` (`hooks/useStopLiveRun.ts`), the one function that stops "the live run a `RunningRun` names": for the dashboard's run it raises `isStopping`, calls `POST /runs/:id/stop` and acts on the engine's `status` (`stopped` detaches the stream and settles the store; a run already finished is recorded as a late Stop, #3367), which is also what the dashboard's own Stop calls;
for a collection run it stops the run and refreshes the History caches (`useStopRun` is a thin wrapper over it for the two History tabs).
A failed stop is a toast with Try again, and Run stays disabled, since the run is still live.
A stopped collection run keeps `scenario-run-store.isStreaming` true until the engine's `complete` frame, so Run reopens a moment after the stop answers, not with it.
Both refuse before `POST /runs`, so no engine run is started past a refusal.
An agent's run has already started on the engine, so it cannot be refused: when the gate is shut the app attaches nothing, for either kind, and shows one toast; see `useRunWatchers` under the MCP section.
The URL bar's Load test button follows the same gate through `useCanStartLoadRun()`, so it never offers a start the click would refuse: **View load test** (the dashboard) while the dashboard's run is live, **View collection run** (that run's tab) while a collection run streams.
Re-attaching the dashboard to its own run asks a narrower question, `canReattachLoadRun()` (`reattachGateOf`), which refuses only while a collection run streams: the dashboard's run being live is the reason to re-attach, not a reason to refuse.
The lost-stream callout's Reconnect refused that way opens the collection run's tab with the same warning toast as the builder, and the dashboard's re-attach on mount, which nobody asked for, stays on the callout without one; either way the collection run keeps its stream.

1. User configures load test in the dashboard modal (duration, concurrency, etc.)
2. The request half is composed engine-side (`useEngine().composeRequest()`), then `apiService.startLoadTest()` sends the composed payload plus the load config to `POST /runs`
3. Engine responds with `runId`
4. `useDashboardStore().startRun(runId, config, requestInfo, requestId)` initializes dashboard state
5. `loadTestService.startMonitoring(runId)` connects to `/runs/:runId/live`
6. As metrics stream in, `addMetricsBatch()` folds them into historical metrics (trimmed to `liveWindowSeconds`, backstopped by `maxRetainedTicks`) and updates running aggregates (peak concurrency, SLO breakpoint)
7. Dashboard view shows live metrics, request/response (from the SSE stream's final response), and aggregates
8. When the run completes, the engine sends a `complete` event
9. `LoadTestService.handleClose()` fetches the final report through the query cache (under `queryKeys.runs.report(runId)`, with `staleTime: 0` so a mid-run copy a History tab cached is not served as final, #1934) and hands it to `setFinalReport(runId, report)`, which settles the phase as `finished` - **only if the dashboard is still showing that run**.
   The write is addressed to the run the close was for, and the store drops it for any other: finishing run A and immediately starting run B otherwise landed A's report on B's dashboard, flipping a running test to "completed" with A's percentiles.

    A dashboard that mounts on a run whose stored report is already terminal calls `loadTestService.settleOnStoredReport(runId, report)` (#3380), not `stopMonitoring()`: it releases the stream and posts how the run really ended (finished, failed or stopped, each with its own kind and title), once.
    `stopMonitoring()` is the user's Stop only and would post "stopped" for a completed run.

    **The dashboard's Stop reads the engine's answer** (#3367).
    `POST /runs/:runId/stop` answers `stopped` (the Stop took effect), `completed` or `failed` (the run had already finished when Stop arrived), or `running` (the strategy returned on its own and the run ends by its own verdict).
    On `stopped`, `handleStop` calls `stopMonitoring()` and `stopRun()` as before, so the Running pill and Stop drop at once.
    On `completed` / `failed` it does neither:
    the stream's close or the report effect settles the run with the engine's status, `noteLateStop()` sets `stopArrivedLate` (cleared by the next `startRun`), and the finished view shows an info callout, "The run had already finished when Stop arrived.", between the header and the report, unless the stored report carries `summary.drainCut` (read by `drainCutCancelledOf`):
    that Stop cancelled requests during the drain, so it did something, the verdict line already says the run was not judged, and the callout would contradict it (#3538);
    from a lost stream, which nothing will close, `noteLateStop` also awaits the report.
    On `running` nothing changes: the run keeps streaming and no note is shown.
10. Dashboard settles as `finished` with kind "completed" (or "failed" / "stopped", which lay out the same final report) showing the final report; the runs lists are invalidated so the terminal status lands without waiting for a poll, and so are the run's detail, report and series, which a History tab on the same run read while it was live
11. **A stream that ends without a `complete` status is not a finished run** (issues #1925, #2140).
    The engine's `complete` frame normally carries the run's `status`, which `handleClose(status, { frame })` believes over the stored row.
    With no status it reads the same stored report, and if its `metadata.status` is still `running` or `pending` the two endings part ways.
    A dropped connection (`frame: false`) moves the phase to `streamLost` instead of landing the final report, posts no notification, and lets go of the run so Reconnect can start watching it again.
    Reconnect resumes the stream after the last frame the client received (`?lastEventId=`, #3571), so the series carries on without a repeated tick and `currentMetrics` is kept; the ticks buffered when the stream dropped are committed once by that close and are not delivered again.
    A bare `complete` frame (`frame: true`, the engine's 60 s settle timeout) is waited out instead: the service re-reads the report every 500 ms for up to 30 s and finishes the run as soon as it is terminal, falling back to the report's own status to tell failed from finished, then loses the stream the same way only if the bound passes.
    That wait is cancelled by a generation counter on the service (`settleGeneration`), bumped by `startMonitoring`, `releaseRun` (so `stopMonitoring` and `handleSuperseded`) and `handleError`; a bare `activeRunId` check could not do it, because Reconnect puts the same id back.
    A cancelled wait does nothing: no report, no notification, no error.
    A collection run taking the shared stream (`handleSuperseded`) loses the stream the same way, and fetches nothing, and so does a stream error (`handleError`).
    Either way the run stays live, so the dashboard keeps its running layout, the Running pill and Stop, under the "Lost the live metrics stream" callout.
    The dashboard's own report effect is the backstop for a stream that stopped with no report in the store: one retry-capped fetch armed in the `awaitingReport` phase (and in `engineStopped` once an engine serves again, #3605), so it holds off while that callout is up, and re-armed by the report callout's Retry.
    A fetch that keeps failing gives up to `reportError`, whose Retry re-arms it; a report that still says running after every attempt gives up to `streamLost` instead, with the body "The stream closed, but Vayu's engine still reports this load test as running.", because `reportError` is not live and would take the pill and Stop away while the engine still generates load.
    From there Reconnect is the user's to press, so nothing re-fetches on its own.
    A run whose Stop the engine confirmed is not raised back to live: its still-running report gives up to `reportError` like a failed fetch.

### Saving a Request with Auto-Save

1. User opens or creates a request tab via `useTabsStore().openTab()`
2. Component mounts `useSaveManager()` with the request ID and save callback
3. Hook registers the context with `useSaveStore()` for Ctrl/Cmd+S integration
4. User edits the request (URL, headers, body, etc.)
5. `hasChanges` is marked true and `changeToken` is bumped, arming the debounce timer - `autoSave.delayMs` from `client-settings-store`, 5s by default (Settings → General offers 5s / 30s / 1m)
6. A further change within that window bumps the token again, which tears the pending timer down and arms a new one, so the delay measures from the last edit
7. After the delay elapses with no edit, `performSave()` is called, which calls the `onSave` callback
8. Save status updates in `useSaveStore()`, and the Dock shows "Saving..." then "Saved" for `TIMING.SAVED_STATUS_DURATION_MS`
9. **A save is only allowed to call the entity clean for the generation it sent** (#1381).
   `onSave(request, changedFields)` serialises the state - and the set of touched fields - as they were when the save started, so a keystroke landing during the round trip is not in that payload.
   The generation also moves on a foreign write the per-field merge adopts or conflicts, not only on the user's own edits (#1436): a save in flight when that happens must not clear `hasUnsavedChanges` over a value the merge just changed underneath its response.
   The provider records the generation beside the snapshot and clears `hasUnsavedChanges` - and the fields the snapshot named - only if the token has not moved when the write lands; the hook applies the same check to the "Saved" indicator.
   Clearing unconditionally marked that keystroke saved, left nothing dirty for the next timer to fire on, and lost the edit
10. **The request builder's `onSave` sends only `changedFields`** (#1436, see [the draft adopts an external write per field](draft-hooks.md#the-request-builders-draft-adopts-an-external-write-per-field) above) - an untouched field is omitted from the `PUT` rather than resent unchanged
11. On **tab switch or unmount**, any pending save is flushed before the context is unregistered - unless the entity is confirmed gone (`useSaveManager`'s `enabled: false`), which the request builder sets once its request is deleted elsewhere, so the flush never fires a doomed PUT.
    If that flush fails, the context is re-registered under the same id rather than left unreachable - `flushAll`'s reconnect trigger (below) and a later quit both walk the registry, not the pane that just unmounted (#1489)
12. On **app quit** (Electron `before-quit`; on Windows a logoff or shutdown reaches it through the window's `query-session-end`, which `session-end.ts` turns into a quit) *and* on **window close** (the X button), `useSaveStore().flushAll()` saves all dirty contexts and resolves to `{ saved, failed, pending }` - what actually landed, not just that the round trip finished.
    Each count is the sum of the contexts' own verdicts: `pending` is an edit that settled unsaved (a blocked save), `failed` one the engine refused

**Both window-destroying paths flush, through one coordinator.**
`before-quit` always did; `close` did not, and `close` is what the X button fires - it destroys the WebContents and nulls the window handle, so the `before-quit` that followed found no renderer to ask and skipped the flush entirely (on macOS, `close` does not quit at all, so the edits were simply gone with the app still running).
`electron/quit-flow.ts` is the one state machine both gestures go through - `idle`, `confirmingServices`, `flushing`, `confirmingLoss`, `proceeding` - and owns the flush and its 2s ACK ceiling, which is why "already flushed" is shared state: a quit that flushed and then closes the window must not ask a dying renderer twice.
A flush is only requested of a page that can answer (`createFlushRequest`): no window, a gone renderer, or a page that has not finished loading (`openIntents.isReady()`, the open intents' own `did-finish-load` signal) settles at once with nothing to save, rather than waiting out the ceiling and asking about edits that page never held (#3610).
It lives outside `main.ts` so it can be tested - `main.ts` creates windows and starts the engine at import time.
Once a quit is let through, `quit-shutdown.ts` stops the engine and the MCP server.

**A running service is asked about before either path flushes** (#1363).
A close or quit that would stop an inbox, mock server or mock issuer names it and waits for an answer first, and Cancel leaves the window, the renderer and every pending save exactly as they were - a flush run ahead of the question would have told the renderer its work was ending.
Confirm, and the flush runs as it always did on the way out.
The yes lasts for that one way out: the close and the quit it turns into are not asked twice, but Cancel or Keep working forgets it.

**The flush settling is not the same as the flush landing** (#1489).
Before, both paths closed the window the moment the round trip finished - the ACK, or the 2s ceiling if the renderer never answered - whether or not anything had actually been saved: a refused write, a hung engine, or a save still running when the ceiling gave up all looked identical to a clean quit.
The renderer's `flushAll` now carries its outcome back over the `before-quit-flushed` ACK (`FlushResult`, `electron/save-flush.ts`), and a settle with no ACK at all (the ceiling won) is treated the same as a failure - nothing is known to have landed.
Either case holds the close behind one native dialog, `buildFlushFailurePrompt`:
"Couldn't save N edits - the engine isn't responding" for a failure or the unanswered ceiling, "Couldn't save N edits -
the disk is full" (detail: "Free up space, then keep working to save again") when every failure was a 507 and `FlushResult.reason` says so (#2423), and "N edits couldn't be saved as they are" when every loss is a blocked save (`pending` only, where the engine is fine), **Quit/Close anyway** or **Keep working**.
A clean flush still closes with no dialog, exactly as before, and a quit from a signal never asks: it logs the flush result at warn and proceeds (#1908).
**Keep working returns the flow to `idle`** (#3335): the flush and the services answer are both forgotten, so the next quit or close flushes again and asks again rather than going straight through with the edits the user chose to keep.
Each flush request carries a flush id on `before-quit`, the preload echoes it on `before-quit-flushed`, and an ACK whose id is not the flush in flight is dropped, so a late answer to the first flush cannot settle the second.
A renderer that is replaced - a crash recovered, a hung one reloaded from the "not responding" dialog, a new window on macOS - resets the flow the same way.
`useTabsStore.closeTab` asks the same question one tab early: closing a single dirty tab while the engine is not `connected` keeps the tab and toasts instead of letting the unmount flush fail into a pane that no longer exists; `closeOtherTabs` and `closeTabsToRight` hold back their dirty tabs the same way (#3324).

### Variable Resolution Priority

1. User activates a request in a tab.
   The environment comes from `useSessionStore().activeEnvironmentId`; the collection comes from the request's own `collectionId` - **not** from the session store, which has held no collection scope since the `vayu.session` v2 migration
2. Component calls `useVariableResolver({ collectionId })` - the environment is not passed, the hook reads it from the session store
3. Hook fetches globals, collection variables, and environment variables via TanStack Query
4. When `resolveString("https://{{baseUrl}}/{{path}}")` is called:
   - First, check environment variables for `baseUrl` and `path`
   - If not found, check collection variables
   - If still not found, check global variables
   - Replace with the first match found, or leave `{{variableName}}` unreplaced if no match

## Best Practices

1. **Cross-cutting vs. module-local:** Store cross-cutting UI state (tabs, layout, engine, save) in `app/src/stores/`; store feature-specific UI state (collections tree, history filters, variables category, settings category) in `app/src/modules/<feature>/<feature>-store.ts`.

2. **Zustand for transient UI state:** Use Zustand for UI state that doesn't persist to disk (or is ephemeral per session).
   Decorate with `persist` middleware to survive page reloads if needed (e.g., open tabs, drawer state).

3. **TanStack Query for server state:** Use TanStack Query for collections, requests, environments, globals, runs, and reports.
   It is the single source of truth and ensures consistency across the app.

4. **Save manager integration:** Use `useSaveManager()` in any component that edits a persistable entity (request, environment, etc.) that autosaves.
   It handles debouncing, context registration, and centralized save state.
   Do not manually call `useSaveStore()` for auto-save.
   For an editor that holds a draft instead - committing it on blur or on an explicit button - use `useEntityDraft()` **plus `useDraftSaveContext()`** - the first owns the draft, the second puts it in the registry - and do not hand-roll the draft/resync/`isDirty`/mutation-reset parts again.

5. **Centralized save on app quit:** On Electron's `before-quit` event, call `useSaveStore().flushAll()` to persist any pending changes before the app closes.
   An editor that is not registered is not merely unsaved here, it is invisible - which is how the collection tabs lost drafts silently for as long as they existed.
   `flushAll` reports what happened (`{ saved, failed, pending }`), and the main process (`electron/quit-flow.ts`) asks before discarding anything it did not save (#1489) rather than closing on faith - on the window's close as well as on quit.

    Corollary: **an editing surface must never fail without saying so.**
    There is no global `MutationCache.onError` in `lib/query-client.ts`, so a bare `mutation.mutate(...)` reports nothing at all.
    Route the failure through `reportFailed` (toast + "Not saved") when the edit stays on screen, a toast when the surface rolls it back, or render the mutation's `isError`, and roll an uncontrolled input back to the stored value while you are at it - the context bar's variables section did neither, so a rejected edit sat on screen looking committed.

6. **Leaving an editor saves or asks; it does not drop.**
   A settings category switch, an unmount and a tab switch are each a place dirty state could be discarded silently, so each saves or asks.
   Settings flushes its valid edits on the way out (engine config writes are cheap merge-patches); the collection tabs keep their panels mounted so there is nothing to discard.

7. **Tab LRU and dirty state:** The tab store reads the save registry and refuses to evict a dirty tab (`isTabDirty`, matched by tab *type* - the registry is keyed by editor and the two do not line up).
   Nothing is flushed during eviction, because the predicate has already declined to take unsaved work; over the cap with every candidate dirty, no tab closes at all.
   An *explicit* close (`closeTab`) is not eviction, but it applies the same `isTabDirty` check and only refuses when the engine is not `connected` (#1489) - a dirty tab closes and flushes as usual once the engine can actually take the write.

8. **Response persistence:** Responses are stored in memory (not localStorage) so they survive tab switches but are cleared on page reload.
   This balances UX (quick switch back) with memory (responses can be large).

9. **Live metric retention is a time window, not a point count.**
   `addMetricsBatch` trims ticks older than `liveWindowSeconds` (the engine's `liveReplayWindowMs`, 5m by default, `null` = full run), with `maxRetainedTicks` (`DEFAULT_MAX_RETAINED_TICKS`, 50,000) as a memory backstop.
   Both are engine config so the replayed span and the displayed span cannot disagree.
   The only knob in `config/metrics.ts` is `METRICS_UI_THROTTLE_MS`, the SSE commit throttle; chart cost is bounded by bucketing (`chartBucketSeconds`), not by dropping ticks.

10. **Variable resolution priority:** Always resolve variables in priority order: environment > collection > global.
    Use `useVariableResolver({ collectionId })` to scope a preview to a collection; the active environment comes from the session store and is not a parameter.

11. **Lazy loading and prefetch:** Use `usePrefetchCollectionsAndRequests()` and `usePrefetchRuns()` on app init to warm up caches.
    Lazily fetch environments, globals, and run reports only when needed to reduce initial bundle size and API load.
    Warm a *polled* list with a prefetch, never by mounting its hook at the root - an observer that lives for the session polls for the session (#1150).

12. **Select fields, never the store.**
    Calling a Zustand hook with no selector (`useTabsStore()`) subscribes to the whole state object, so the component re-renders on every `set()` to that store regardless of which field changed.
    Call the hook with a selector for each field the component reads (`useTabsStore((s) => s.openTabs)`), and read an action through the hook's own `getState()` (e.g. `useTabsStore.getState().focusTab(...)`) inside a handler rather than selecting it in render - actions are stable references, so selecting one buys nothing and widens the read.
    When a component genuinely needs several fields together, wrap the selector in `useShallow` from `zustand/react/shallow` rather than returning a bare object literal, which fails Zustand's identity check and re-renders every time regardless of whether the picked fields changed;
    a selector that derives a fresh array or object (`.filter(...)`, `.map(...)`) has the same problem and no wrapper fixes it, so derive downstream of a field selector with `useMemo` instead.
    `app/src/stores/store-selectors.test.ts` scans `app/src` for all three shapes and fails on any it finds outside its allowlist (#1714).
