---
description: >-
  The cross-cutting Zustand stores for load-test metrics, host sleep under a run, live collection-run steps and live streaming-request events.
---

# Dashboard and live run stores

## `dashboard-store.ts` - Load Test Metrics & State

Manages live load test run state: streaming metrics, final reports, and running aggregates (peak concurrency, SLO breakpoint).
Retention is **time-based, not a fixed point count**: `addMetricsBatch` trims ticks older than the user-configurable live window (`liveWindowSeconds`, default 5m, `null` = full run), backstopped by a `maxRetainedTicks` ceiling (default 50,000).
Both are kept in sync by `useLiveWindowSync`, mounted once at the App root (not scoped to Settings, so a run streaming with the panel never opened still uses the engine's values), and drive what the live charts plot.
(`app/src/config/metrics.ts` now only holds the SSE commit throttle, `METRICS_UI_THROTTLE_MS`.)

**The window is engine config, not a renderer preference.**
It is stored as the engine's `liveReplayWindowMs` entry (milliseconds; `0` = full run), so `useLiveChartSettings` (the picker's editor) reads it from `useConfigQuery` and writes it with `useUpdateConfigMutation` - there is no localStorage key.
The engine needs the same number: it sizes the in-memory SSE tick ring that `GET /runs/:runId/live` replays - from offset 0 for a first attach, which is what rebuilds these charts when the dashboard attaches mid-run, and from the last frame held for a Reconnect (#3571).
Two settings would let the retained span and the displayed span disagree, with the engine replaying less than the chart is configured to show.
`constants/live-window.ts` owns the option list and the `liveWindowToMs` / `liveWindowFromMs` mapping.
The Dashboard picker is its **only** editor: a second one in the engine settings list would sit under a different label and a different save model (#586), and `ENGINE_SETTINGS_EDITED_IN_APP` (`modules/settings/engine-settings-edited-in-app.ts`) is what keeps that row out of it.

The **tick ceiling** is shared the same way, as `liveMaxRetainedTicks` (default 50,000).
It is a memory bound, not a rendering one - `bucketColumns` collapses ticks into `chartBucketSeconds` buckets (0.5s by default) before uPlot sees them, and uPlot draws to canvas, so a full window reaches the screen as a few thousand points however many ticks back it.
It also costs nothing at stock settings, since the *window* is what sizes the retained history; it only binds when window / tick-interval exceeds it.
`DEFAULT_MAX_RETAINED_TICKS` here and `DEFAULT_MAX_LIVE_TICKS` in the engine are the pre-config defaults and must move together.

Because the value arrives asynchronously, the store seeds `liveWindowSeconds` with the module default rather than reading it synchronously at creation; `useLiveWindowSync` corrects it once the config query resolves.

**State:**
```typescript
{
  currentRunId: string | null
  phase: DashboardPhase                 // Where the held run stands; see below (#3351)
  currentMetrics: LoadTestMetrics | null
  historicalMetrics: LoadTestMetrics[]  // Trimmed to liveWindowSeconds (cap: maxRetainedTicks)
  monitorSamples: MonitorSample[]       // Server vitals scraped this run (cap: maxRetainedTicks)
  liveWindowSeconds: number | null             // Live retention window; null = full run
  isStopping: boolean                          // A Stop request for the held run is in flight
  stopArrivedLate: boolean                     // The engine answered Stop completed/failed: the run had finished first (#3367); the finished view says so unless the report carries `summary.drainCut` (#3538)
  loadTestConfig: LoadTestRunConfig | null     // Config snapshot during run; `runOwnSloMs(loadTestConfig)` (capacity `sloMs`, else the `latencyP99Ms` budget, else undefined) is the SLO line the live charts draw
  requestInfo: LoadTestRequestInfo | null      // Request snapshot during run
  peakConcurrency: number                      // Running max (monotonic)
  breakpoint: Breakpoint                       // SLO crossing (latched on first breach);
                                               // carries the sloMs it was judged against (a capacity run's own `loadTestConfig.sloMs`, read through `setRunConfig` too for a run started by an MCP agent; the Settings threshold in every other mode),
                                               // its `sloSource` (`"run"` only where that number is the run's own p99 line, else `"settings"`, which the labels word as "threshold in Settings", not "SLO") and atRunStart (no reading under it came first)
}
```

**Key Methods:**
```typescript
startRun(runId, config?, requestInfo?, sourceRequestId?)  // The one writer that replaces the held run
// Every writer below names its run and is dropped for any other:
setRunConfig(runId, config, requestInfo)  // Fill in loadTestConfig / requestInfo of a run started without them (agent runs)
streamOpened(runId)                 // Stream attached, or re-attached by Reconnect -> streaming
streamLost(runId, message)          // Error, drop or takeover while the engine runs on -> streamLost
streamClosed(runId)                 // streaming -> awaitingReport
engineStopped(runId)                // The engine's process ended under a live run (#3605) -> engineStopped; setFinalReport is the exit
stopRun(runId)                      // The engine confirmed Stop took effect (answered `stopped`) -> awaitingReport, stopped
noteLateStop(runId)                 // The engine answered Stop completed/failed: records stopArrivedLate; a lost stream awaits the report
addMetricsBatch(runId, batch)       // Fold a batch into history and update aggregates
addMonitorSamples(runId, batch)     // Append scraped server vitals, bounded by maxRetainedTicks
setFinalReport(runId, report)       // -> finished, unless the report says the run is still live
reportFailed(runId, message)        // The report fetch gave up -> reportError
retryReport(runId)                  // Retry -> awaitingReport
setStopping(runId, stopping)
setLiveWindowSeconds(seconds)       // Update the live retention window (from useLiveWindowSync)
setMaxRetainedTicks(ticks)
```

**`phase` is the one encoding of where the held run stands** (issue #3351).
It replaced four fields - `mode`, `isStreaming`, `error` and `finalReport` - that could disagree: a stream error left `isStreaming` true beside its message, so the pill said Running over a dead stream; a superseded or dropped stream left neither streaming nor settled, so the pill vanished while Stop still showed; and "awaiting the report" was only the absence of every other flag.
Each phase carries only its own payload, in the style of `SpecSync.tsx`'s `CheckState`:

```typescript
type DashboardPhase =
  | { phase: "idle" }
  | { phase: "streaming" }
  | { phase: "streamLost"; message: string }       // The engine runs on; the callout's body
  | { phase: "awaitingReport"; stopped: boolean }  // `stopped`: the engine confirmed the user's Stop; the report still decides the ending
  | { phase: "reportError"; message: string; stopped: boolean }
  | { phase: "engineStopped" }                     // The engine's process ended under the live run; its stored report says how
  | { phase: "finished"; kind: "completed" | "stopped" | "failed"; report: RunReport }
```

Two pure derivations are exported beside it, and every reader asks them rather than the phase.
`isDashboardRunLive(phase)` is whether the run may still be executing on the engine: true for `streaming`, `streamLost` and an `awaitingReport` the user did not stop.
The header's Running pill and Stop button (Finishing and Stop waiting while the latest frame's `phase` is `draining`, #3568: the engine's word, carried on every live frame through `mapSseMetrics`, read from `currentMetrics` and never inferred from elapsed against the duration),
the keep-awake prompt and the single-run gate (`canStartLoadRun`, below, which the URL bar's Load test swap and the Run Collection dialog follow) all read it, so a lost stream keeps the run live everywhere, Running beside the "Lost the live metrics stream" callout.
A `reportError` is not live: the stream had already closed, and holding the builder on a read that cannot answer would lock out every new run until the engine did.
Nor is `engineStopped` (#3605): the engine's process ended under the run, so nothing is left executing it and a Stop has nobody to reach.
It is reached only from a live phase, never through `awaitingReport` (which is live), and only the run's stored report moves it on, through `setFinalReport`, once an engine is back; a restarted engine has settled the orphaned run as failed, so it lands as `finished` with the partial-run banner.
`dashboardRunEnding` answers null for it, since only that report can say how the run ended.
The dashboard fetches that report itself, with the same effect and cap as `awaitingReport`, once `useEngineServing` says an engine answers (never through `awaitingReport`, which is live); if the cap is spent the phase stays and the notice with it, since `reportFailed` applies only to `awaitingReport` and its Retry would go live.
`dashboardRunEnding(phase)` is how the run ended as far as the dashboard knows - the report's kind, or "stopped" from the engine's confirmed Stop before the report lands - and is what the pill names when the run is not live.
`useHostSleepRecorder` is the one reader that wants the stream itself rather than the run, and reads `phase === "streaming"`: a lost stream's last tick is not where the run had got to.

**Every writer but `startRun` is addressed to a run, and a write for a run the store is not holding is dropped**, as in `execution-events-store` below.
A continuation can outlive its run - `handleClose`'s awaited report fetch, a Stop request, a buffered flush - and landing on the run that replaced it was the defect #1925 and the finishing-run-A-starting-run-B race both were.
A transition that does not apply from the current phase is dropped too: a close after a lost stream keeps the callout, a re-attached stream does not raise a stopped, settled or engine-stopped run back to Running, and nothing moves a finished run but the next `startRun`.

**`setFinalReport` ignores a report for a run that is still live** (issue #1925).
The engine answers `GET /runs/:id/report` for a running run too, with `metadata.status` saying so, and taking that answer as final painted Completed and removed the Stop button while the run kept generating load.
A report whose status is `running` or `pending` leaves the store untouched, whichever caller fetched it; a report with no status at all is still taken as final.
A report that lands settles the run as `finished`, with the engine's status as its kind: `failed` stays failed (#1932), and a Stop the user pressed does not override it (#3367), so the dashboard reads the run as History and the report do.
Any of the three renders History's `LoadTestDetail` over the report (#2136, #2220); until one lands the live view stays, carrying the report Retry.
`isRunInProgress` (`lib/run-status.ts`) is the one test, shared with `LoadTestService` and the dashboard's report effect.
Its counterpart `isRunTerminal` (completed, stopped or failed) is the one spelling of the settled set; an unrecognised status is neither.

**A view of a stored run asks `useRunLiveness(runId, status)`** (`hooks/useRunLiveness.ts`, #3351) whether that run is live: `ScenarioRunView` (Stop, the live progress line, the waiting empty state), `HistoryDetail` (the in-progress pane in place of a load run's report) and `HistoryList` (whether the delete confirm says it stops the run first).
It joins the status the caller already holds, from `useRunQuery` or a runs list, with whichever live surface in this window holds the run: the dashboard, by `isDashboardRunLive`, or a collection run's stream.
One answer outranks the status: a run the engine's process ended under (#3605), the dashboard's `engineStopped` phase for that run id or the scenario store's `endedByEngineStop`, is never live, because its stored status is the cache's last read from an engine that is gone.
The rule is `isRunLive` in `lib/run-status.ts`: a terminal stored status is final whatever a stream that has not caught up says, an in-progress one keeps the run live through a lost stream, and only a status not read yet, or not recognised, defers to the streams.
The caller passes the status rather than the hook reading the run's query, because a second observer of `runDetailOptions` would be a second poll of the same run.
The dashboard's own surfaces (the header pill, the keep-awake prompt) ask `isDashboardRunLive` directly, since the run they describe is whichever the dashboard holds.
The in-progress pane's Stop waiting label (#3568) reads `phase` from that same `runDetailOptions` observer (`GET /runs/:id` carries it for an active run only, read through `runPhaseOf` so an unrecognised value is absent), so it adds no poll.

The load-test dialog seeds its scrape cadence and bounds its metric list from the engine's `monitorIntervalMs` / `monitorMaxSeries` settings, through `useMonitorSettings` - the same read-the-engine's-copy arrangement `useLiveChartSettings` uses above, and for a sharper reason:
this dialog always sends an explicit `intervalMs`, so a renderer-local default would mean the setting never applied to a run started here at all.

`monitorSamples` is kept **beside** the ticks rather than merged into them: the two are sampled by different clocks (the engine's tick cadence and the user's scrape interval), so they are joined onto one x axis at render time by `joinMonitorToTimeline` - which is also where a failed scrape becomes a gap in the line rather than a plateau.
The array is empty for a run that configured no monitor, and that emptiness is what keeps the vitals chart row off the dashboard entirely.
It carries its own copy of the tick ceiling because a scrape can be configured faster than the tick cadence.

There is deliberately no store-wide `reset`: `startRun` already wipes the series, the report and the aggregates, and a reset on top of it nulls `currentRunId` - the dashboard then shows no active test while one streams.

**Non-persisted** (fresh per session).

## `host-sleep-store.ts` - When The Machine Slept Under A Run

The intervals the host spent asleep while a run was streaming (issue #1357), keyed by run id.
The app holds a system wake lock for the length of a run, but that lock is a request to the OS: a closed lid or a critical battery overrides it, and the run's series is then missing a stretch that nothing in it explains.

The record lives here rather than in the run report because the engine was suspended too and knows nothing about it.
`useHostSleepRecorder` writes it - the main process's `power:suspended` carries the anchor (where the run had got to, read off `dashboard-store` on the way down, since the renderer is frozen in between) and `power:resumed` carries the duration.

**State:**

```typescript
{
  byRun: Record<string, HostSleep[]>  // { at, durationMs, startSeconds }, oldest first
  runOrder: string[]                  // first-annotated order, for eviction
}
```

Two readers, both by run id through the `useHostSleeps(runId)` selector rather than one prop drilled to both: `MetricsView` and `PerformanceTab` mark the sleeps on the charts, `OverviewTab` states them in `RunEvents`.
The selector returns one frozen empty array for a run with no sleeps, so a dashboard rendering at 10 Hz is not re-rendered by a stable absence.

**Persisted**, bounded to the newest `MAX_RUNS` (20) runs and `MAX_SLEEPS_PER_RUN` (20) intervals each: the gap outlives the session that produced it, and a user who finds the hole tomorrow needs the same answer, but localStorage is a fixed budget shared with the workspace.
`migrate` and `merge` both normalize, as `recovery-notice-store` does and for the same reason.

## `scenario-run-store.ts` - Live Collection-Run Steps

The live half of a scenario (collection) run's tab.
`ScenarioRunService` pushes the `step` SSE events in here and `ScenarioRunView` reads them, so the stream survives navigating away from the tab and back - the same split, for the same reason, as `LoadTestService` and `dashboard-store`.

It holds **one** run.
A scenario is sequential and the app starts one at a time, so `startRun` replaces the previous run's steps rather than accumulating; a tab for an older run reads an empty list rather than whatever is streaming now.
**Every other writer - `addSteps`, `setPlan`, `setStreaming`, `streamLost`, `runEnded` - names its run and is dropped for any other** (issue #3351), as `execution-events-store` does: the stream is replayable, so a step from a replaced run can still land on a socket that has not finished closing, and a release for one run must not lower a successor's flag.
`ScenarioRunService` builds its step batcher per run for the same reason, the shape `useExecutionEvents` uses: `handleClose` flushes after it has let go of `activeRunId`, so the commit carries the run it was built for.

**State:**
```typescript
{
  runId: string | null       // The run being streamed, or null
  steps: ScenarioStepRow[]   // Reported so far, in plan order
  summary: StepListSummary   // The outcome counts, plus how many steps are
                             // past the first pass and how many bound a data row
  appendEpoch: number        // Moves whenever the list changed by anything other
                             // than growing at its end
  plan: ScenarioRunPlanEvent | null  // The opening `plan` frame: stepsPerIteration,
                             // iterations, stepsExpected. Null until it arrives
  isStreaming: boolean       // Between startRun and the stream closing or failing
  error: string | null       // A transport failure on the stream
  endedByEngineStop: boolean // The engine's process ended under the run (#3605)
  endedAs: TerminalRunStatus | null  // How the run ended, once this window knows
  thresholdValidation: RunReport["thresholdValidation"] | null  // The stored
                             // report's budget block, written with endedAs
}
```

`runEnded(runId, status, thresholdValidation)` records `endedAs` and the stored report's budget block and lowers `isStreaming` in one write.
`ScenarioRunService.handleClose` calls it once the report refetch below has answered: with the engine's completion frame, or, for a stream that closed without one (#1415), with the stored report's status when it reads as terminal; a run the report still calls running only lost its stream, and `endedAs` stays null.
The wait is for the budgets (#3539): the frame carries a status alone, and one write is what lets `RunAnnouncer` (#3498) say the ending once with a missed budget in it, rather than the counts first and the budget in a second announcement.
A refetch that failed records no block, and the ending is still said with the counts.
The terminal notification is posted at the same point and from the same block.
Both fields' one reader is `RunAnnouncer`; the run tab reads the stored record, not these.

`streamLost(runId, message)` records a transport failure and lowers `isStreaming` in one write.
The run keeps executing on the engine, and `ScenarioRunView`'s "is it live" is `useRunLiveness(run.id, run.status)`, so once the stream says nothing more the run's stored status answers, instead of a Running spinner standing beside "Live updates stopped".

`engineStopped(runId, message)` is the same write for a run whose engine's process ended under it (#3605), with `endedByEngineStop` raised beside it; `startRun` clears it.
`ScenarioRunService.handleEngineStopped` makes it, and two surfaces read the flag: `ScenarioRunView`, so the "Live updates stopped" callout drops its "The run itself is unaffected" sentence, which a dropped stream earns and an engine stop does not, and `RunAnnouncer`, which says "Collection run ended.
Vayu's engine stopped" once (#3621), since the stop sets no `endedAs` for it to hear.
It does not say it over a run whose `endedAs` is already set, and a later `runEnded` is still announced.

**A batch per flush, not a commit per event** (issue #1153).
`ScenarioRunService` buffers arriving `step` events and commits what it collected on the user's `liveRefreshMs` cadence, the same throttle `LoadTestService` puts on its ticks.
The premise for having none - that a scenario's step rate is bounded by request latency - does not hold: the engine's scenario loop is sequential with no pacing, so a local target returns hundreds of steps per second, and each one would cost a full copy of the step list, a store notify and a re-render of the run tab.
The buffer is committed on the leading edge of a window and again on a trailing timer, and drained when the stream closes or fails; a run replaced mid-flight discards whatever it left buffered, since those rows belong to a list the store has already cleared.
That mechanism - buffer, leading edge, trailing timer, and the `liveRefreshMs` read behind it - is one implementation, `services/throttled-batcher.ts` (issue #1206), and now has a third caller: `useExecutionEvents` buffers a design-mode request's streamed events through it the same way (issue #1158).
When to flush and when to discard stay each caller's own, because the lifecycles genuinely differ - the design-mode hook flushes on teardown rather than discarding, because a teardown there is as often the builder unmounting mid-stream as it is a replacement, and the store's run guard is what drops the leftovers in the second case.

Steps are folded in by `foldStepEvents` (`modules/history/main/scenario-steps.ts`), which keys on `(iteration, stepIndex)` rather than arrival order: the engine's SSE ring replays from `Last-Event-ID`, so a reconnect re-delivers events already rendered and an append-only list would double every row it re-saw.
A whole batch costs one array copy, and the fold returns the state it was given when every event in the batch was an idempotent replay, so a reconnect's replay does not re-render the list.

`summary` is maintained by that same fold rather than recounted by the view - the `dashboard-store` aggregate stance, for the same reason: a scan per commit is a scan over a list that grows for the length of the run.
`ScenarioRunView` is its reader, for the four count chips and for the two whole-list questions its rows answer.
It does **not** displace the report: once `report.scenario` can give the run's own totals those win, because thinning drops passes and the stored rows undercount them (see `docs/app/COMPONENTS/history.md`).
`summarizeSteps` answers for the stored rows, which arrive complete, and is the oracle the incremental summary is tested against.

`appendEpoch` is the second thing that fold publishes, and the reason it has to (issue #1205).
Every commit hands the view a new array - immutability, which zustand's change detection depends on - so from the rows alone an appended row and a replaced one look alike, and a reader that wants to keep anything derived from the list has to compare the two lists to find out.
The fold already knows, so it says: `foldStepEvents` returns `appendedOnly` beside the fold, and the store turns it into a monotone counter that moves for a replay that replaced a row, a gap-resume that spliced one in, and a `startRun` that emptied the list.
`useFilteredSteps` (`modules/history/main/`) is its reader: it counts what the batch that arrived added to a chip's or the search box's match, and produces rows only as far as the growing window it owns has to show them, so a narrowed live list costs one predicate pass over the batch rather than over the whole run per flush - and, once that window is full, no array copy at all (issue #1297).
Monotone matters - React may render once for two commits, and a value that could return to one a reader had already seen would let a stale prefix through.

`plan` is the engine's `plan` frame, which opens the stream before the first step (#1398).
`ScenarioRunService.handlePlan` keeps `stepsExpected` for the OS progress bar and hands the whole frame to `setPlan`, addressed to its run, which `startRun` clears and which is dropped for any other run, the way `addSteps` drops a stray batch.
`ScenarioRunView` reads it, scoped to its own run id, for the live "Iteration k of N" line (`docs/app/COMPONENTS/history.md`); it is meaningful only while the run streams, and the report's `scenario` block is what says how the run ended.

Once a run reaches a terminal status its stored `results` rows are the complete record and the view reads those instead.
`ScenarioRunService.handleClose` invalidates `runs.detail(runId)` and refetches `runs.report(runId)` through the query cache - the same keys the tab reads, so a bare fetch would leave the pane on the stale copy.
It also invalidates `runs.lists()` (the History row still says "running") and `runs.lastCollectionRuns()` (the context bar's Last run section says it too, from its own family, and is not polled at all).
The run's scripts and extractors may have written environment, globals or collection variables, so it also invalidates `environments.all`, `globals.all`, `collections.all` and `compose.all`, as Send, history replay and the MCP map do (#3250); unconditional, since a run that wrote nothing costs three GETs.

**That report fetch carries `staleTime: 0`, and the feature rides on it.**
The tab mounts the moment the run *starts* and asks for the report immediately, when the engine has written no step rows yet - they go to SQLite in one batch at the end - so the cache holds a report with an empty `results[]`, seconds old.
Under the hook's own five-minute `RUNS_STALE_TIME_MS` that entry reads as fresh and `fetchQuery` resolves from it without a request, which left the step list on the live rows for the life of the tab and made every step expand into an empty panel, since only a stored row carries the exchange.
This is the one fetch in the app that *knows* the data just changed, so it is the one that must not honour the cache.
The engine writes the rows, then the summary, then the terminal status, and publishes `complete` after all three, so the refetch cannot race the write it exists to pick up.

There is deliberately no `stopMonitoring` on the service and no `clear` on the store: the stream ends on its own when the engine sends `complete`, and nothing in the app stops a collection run mid-flight yet.
Both belong with the stop control that would need them.

**Non-persisted** (fresh per session).

## `execution-events-store.ts` - Live Streaming-Request Events

The live half of a **streaming design request** (issue #574): `POST /execute` with `stream: true` answers `202 {runId, eventsUrl}` and the upstream's own events arrive over `GET /runs/:id/events`.
`modules/request-builder/hooks/useExecutionEvents` buffers the relayed frames through `services/throttled-batcher.ts` and commits a batch per flush window on the user's `liveRefreshMs` cadence, so the store pays one copy and one notify per window rather than per frame (issue #1158) - the same batcher `LoadTestService` and `ScenarioRunService` commit through, now with three callers.
The response pane's Events tab reads the store, so the rows survive switching to another request tab and back - the same split, and the same reason, as `scenario-run-store` above.

It holds **one** stream: a second Send is what closes the first's feed, so two live feeds are not a state the builder can reach.
It closes the feed and not the run: the engine's consumer worker keeps going until the stream's own end rule.
So when the provider's stream branch empties the store (`handOver`) while another request's stream is live, that request's run is held as `displaced` and `startStream` records it in `replacedFeeds` (request id to run id, #3352) once the new stream has opened, so a Send whose stream is refused or never starts claims nothing;
`replacedFeeds` outlives the stream fields; that request's response pane reads it to say its live feed was taken over, and the request's own next Send drops it (`beginSend`, which also counts the send in `sendCounts`).
It also holds the **request** the stream belongs to, not only the run - one `RequestBuilderProvider` serves every request tab, so "are these rows mine?" is a question about the request on screen and a run id alone cannot answer it.
Both the provider and the viewer select against `requestId`, which is what stops a stream started elsewhere appearing under a request that never streamed.

**State:**
```typescript
{
  requestId: string | null      // Whose Send started this stream
  runId: string | null          // The run the engine created; what a Stop names
  eventsUrl: string | null      // Engine-relative, exactly as the answer gave it
  open: StreamOpen | null       // What the stream connected to (the `open` frame)
  events: StreamEvent[]         // Received so far, oldest first
  streamText: string            // Every event's `text` joined as batches land; "" until one carries it (#3773)
  totalEvents: number | null    // The engine's own count, from the `complete` frame
  isStreaming: boolean
  endReason: StreamEndReason | null
  error: string | null          // A transport failure on the relay
  leftOut: LeftOutElement[]     // Draft elements this Send left out (#3066)
  sent: ExampleSentRequest | null // This Send's snapshot (#1763), put on the stored response
  sentAt: number | null         // Epoch ms `startStream` ran (#3775): the zero of row offsets, the status clock and the first event. A stream reopened from History has none here; its stored `events.startedAt` fills `ResponseState.sentAt` instead (#3805)
  finalized: boolean            // Claimed by its finalisation: fetching or landed (#3382)
  replacedFeeds: Record<string, { runId; sent; sentAt; leftOut; finalized }> // Request id -> run whose live feed another request's stream took over
  sendCounts: Record<string, number> // Sends begun per request; a newer one overtakes a late finalisation
  displaced: { requestId; runId; sent; sentAt; leftOut } | null // Live feed `handOver` emptied, recorded by the next `startStream`
}
```

**Every write is addressed to a run, and a write for a run the store is not holding is dropped.**
Not defensive tidiness: the relay replays its retained ring on connect, so a frame from a stream that has already been replaced can still arrive on a socket that has not finished closing - and those rows landing under the send that replaced it is the worst failure here, because such a timeline looks real.

`streamText` is the live reply the Events tab's Text view shows: `addEvents` appends each batch's event `text` (what the request's declared stream text path read, issue #3773) as it lands, so a long stream is not re-walked per render.
It is the live half only - once the run is stored the node's own `streamText` wins, because it is joined over events the stored list has capped.

`totalEvents` is set only from the `complete` frame (falling back to what arrived, so it is never left null once a stream has ended).
While the stream runs, the arrived-so-far count is `events.length`; reporting anything else would be a total nothing had counted.
It matters because it is **not** the row count once a list has been capped, and the Events tab's truncation disclosure compares the two.

Once the run reaches a terminal status the **stored** trace is the complete record: the provider fetches the report, `restore-response.ts` maps its `events` node onto `ResponseState`, and the tab reads that instead - the two-sources-one-list handoff `ScenarioRunView` makes.
That finalisation (`modules/request-builder/context/stream-finalization.ts`) is addressed to the request that streamed, not the one on screen (#3382): it writes the stored response under that request id, touches the live pane only when that request is still showing, and invalidates `runs.lists()`, `runs.recentDesign(id)` and `runs.lastDesign(id)`.
It covers two kinds of run: the held stream once `endReason` is set, and every `replacedFeeds` run, which nothing relays any more and which the builder therefore polls through `runDetailOptions` until the engine reports a terminal status.
Everything it needs is kept here rather than in the provider, because `Shell.tsx` unmounts the builder on every tab that is not a request:
the Send snapshot travels with the run (`sent`, `sentAt` and `leftOut` on the stream, on `displaced` and on the `replacedFeeds` entry), and `claimFinalization` sets the run's `finalized` claim and answers its snapshot only to the first caller, so a re-render, a StrictMode double effect or a remount never fetches twice.
The held stream's claim is a stream field, so `startStream`, `handOver` and `clear` reset it with the rest; a replaced feed's goes with its entry.
A report that cannot be fetched is given back (`releaseFinalization`) and the next mount retries it.
It is not cancelled when another request's `handOver` empties this store mid-fetch, and a newer send of the same request overtakes it: the claim carries the owner's `sendCounts` entry and the landing compares it.
Only the request builder's provider finalizes (the one given a stream handler); the History run view's detached copy leaves this store alone.
What lives here is only ever what arrived on the socket, and it is **not** bounded by the engine's retained ring: that ring (`sseMaxRetainedEvents`, 2,000 by default) is only what a *reconnect* replays, and a client that stays connected is replayed the ring once and then tails the rest of the stream.
What actually bounds the list is the per-stream cap instead - `sseMaxStreamEvents` (100,000 by default, 10,000,000 at the ceiling) or `sseMaxStreamDurationMs` (600,000 ms / 10 minutes by default), whichever the stream reaches first - which is orders of magnitude bigger than the ring and why the Events tab cannot assume the list stays short.
That is also why the tab (`ResponseEvents.tsx`) renders through `useGrowingWindow` with memoized rows rather than the whole list at once, and why a live stream passes its `runId` as the window's `listKey` - the default reset key is the row count, which would snap the window back to its first slice on every batch a growing-in-place list receives.

**Non-persisted** (fresh per session).
