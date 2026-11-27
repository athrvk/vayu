---
description: >-
  The SSE client for a run's live stream: its features, usage and the event types it delivers.
---

# SSE Client (`services/sse-client.ts`)

Server-Sent Events client for a run's live stream - load-test metrics, and a collection run's per-step progress.

## Features

- **Single endpoint**: Connects to `/runs/:runId/live`.
  The engine retains a replayable tick topic, so the client connects immediately after `POST /runs` with no attach race - it replays from offset 0 and tails to the `complete` event (even for sub-second runs).
  The client records the `lastEventId` of every `metrics`, `step`, `plan` and `monitor` frame (one id sequence; the `complete` frame carries none), and a `connect` to the run it already holds frames for opens `?lastEventId=<last id>` so the engine resumes after it (issue #3571).
  A first attach, or an attach to another run, sends no parameter.
  A resume keeps the held metrics and start time; a start resets them.
- **No custom reconnect loop**: The engine sends an explicit `complete` event at normal run end, carrying the run's terminal `status` (issue #2140).
  Transient `CONNECTING` errors are left to the browser's built-in `EventSource` retry.
  `onClose` is called as `onClose(status, { frame })` and the second argument is what tells the two `null` statuses apart: a `complete` frame with no status (the engine's 60 s settle timeout, the rare case) is `{ frame: true }`, and a `CLOSED` readyState with no frame at all is `{ frame: false }`.
  Neither is a terminal status.
  The load-test service reads the stored report (`GET /runs/:id/report`) for both: a terminal `metadata.status` finishes the run.
  On `running` or `pending`, a bare frame is polled again every 500 ms for up to 30 s, since the engine ended the stream and the row is about to settle, and finishes the run when it does; a dropped connection is not waited on, because the run may well still be going.
  Either way, a report still live at the end shows the dashboard's "Lost the live metrics stream" callout and the user's Reconnect re-attaches, resuming after the last frame held (issues #1925, #3571).
  Nothing reconnects on its own.
  `ScenarioRunService` ignores the second argument.
  The browser's own retry does not end by itself when the engine process has died: the `EventSource` stays in `CONNECTING`, retrying a dead port.
  The sidecar's `crashed` push is what ends it (issue #3605): `useEngineLifecycle` calls each service's `handleEngineStopped()`, which `disconnect()`s and settles its run without a notification.
- **Event Handling**: `metrics` events, `step` events, `monitor` events, `plan` events, `complete` event, `error` handling
- **One client, and a hand-off when it changes hands**: the client is a singleton, so a second `connect` takes the socket from whoever held it.
  That subscriber's `onSuperseded` runs first, before the new stream opens, so it can give up its wake lock and its OS progress claim (issue #1417).
  `onClose` is not used for this: a close says the run ended and the stored report is worth fetching, where a takeover says only that the app stopped watching a run the engine is still executing.
  `disconnect()` tells nobody - a subscriber hanging up on itself, and a stream that ended on the engine's `complete` frame, are not superseded by the next run to start
- **Metrics Parsing**: `mapSseMetrics()` transforms the engine's camelCase blob to the frontend `LoadTestMetrics` shape (includes drops, queue-wait, percentiles, bytes, status-code map).
  It marks the tick `live`, maps a gate frame's `secondSamples` / `secondP50Ms` / `secondP95Ms` / `secondP99Ms` and every frame's `cumulativeP50Ms` / `cumulativeP95Ms` / `cumulativeP99Ms`, and leaves an absent key `undefined` and a `null` as `null`, never a `0` (issue #2385).
  The window's own `latencyP50Ms` / `latencyP95Ms` / `latencyP99Ms` follow the same rule: the engine sends them `null` for a window with no completion, and they stay `null` (issue #2386).
  `latencySamples` is not mapped; nothing in the app reads it.
  A gate frame's `cumulativeLatency` and `cumulativePhases` (the run-so-far latency distribution and the per-phase means and percentiles, issue #2782) map to `cumulative_latency` / `cumulative_phases` as sent: `null` is "nothing completed yet", absent is "not a gate frame" (for the phases also "phase histograms off").
  They live on the gate frame alone, so the dashboard reads the latest frame carrying the key from its buffer, never the newest tick.
  Each phase carries `{meanMs, p50Ms, p95Ms, p99Ms, maxMs, count}`; the live view turns them into the report's `timingBreakdown` shape for the waterfall and the percentile table, and shows the latency distribution's `count` as "N completions so far".
  A scenario load run's gate frame also carries `scenario` (`{iterations, iterationsCompleted, iterationsAbandoned, stepsExecuted, meanIterationMs?, steps: [{index, name, executed, errors, label?}]}`, issue #2823; `meanIterationMs`, #3570, is the mean completed pass so far and absent before the first one), mapped as sent onto `LoadTestMetrics.scenario`:
  an mcp step's `label` (`tools/call a`) names the call it makes and is absent on every other step (#3987);
  absent is "not a gate frame" or "not a scenario load", never a zeroed block.
  The live sequence panel reads it from the latest frame carrying it (`utils/liveScenario.ts`).
- **Capacity state**: a capacity run's frames carry `capacity: {level, levelElapsedMs, levelsJudged, stopReason?}` from tick 0 (issue #2928), and `mapSseMetrics()` passes it through as `LoadTestMetrics.capacity` unchanged.
  Absent is "not a capacity run" (or an engine from before #2928), never a zeroed level; `level` `0` is a search that has not opened its first level, and `stopReason` appears only once the search has ended.
  A stored tick never carries it.
  No renderer component reads it yet (the live card is #2929); until it lands the only reader is MCP `get_live_metrics`
- **Step Parsing**: `parseStepEvent()` narrows a scenario run's `step` payload and returns `null` for one it cannot read.
  A malformed event is **dropped, never defaulted** - the step list keys on `(iteration, stepIndex)`, so a defaulted `0:0` would collide with the real first step's row rather than merely say nothing.
- **Monitor Parsing**: `parseMonitorEvent()` narrows a `monitor` frame the same way and returns `null` for one it cannot read.
  A sample defaulted to `timestamp: 0` would join onto the very start of the run's timeline and draw a reading at a moment it was never taken; individual non-numeric entries are dropped, because the rest of the scrape is still real data.

## Usage

```typescript
sseClient.connect(
  runId: string,
  onMessage: (metrics: LoadTestMetrics) => void,
  onError: (error: Error) => void,
  onClose: (status: SSETerminalStatus, info: { frame: boolean }) => void,
                                                  // how the run ended, or null; frame = the engine's
                                                  // `complete` arrived (false: the connection dropped)
  onStep?: (step: ScenarioStepEvent) => void,     // scenario runs only
  onMonitor?: (sample: MonitorSample) => void,    // runs with a `monitor` block only
  onPlan?: (plan: ScenarioRunPlanEvent) => void,  // scenario runs only
  onSuperseded?: () => void                       // another run took the client
);

sseClient.disconnect();
sseClient.isConnected(): boolean
```

## Event Types

- **`metrics`**: Real-time metrics update (JSON payload).
  Load runs only - a scenario run's work is sequential, so a per-tick aggregate would describe one request at a time.
- **`step`**: One step execution of a scenario run - `{iteration, stepIndex, name, outcome, statusCode, latencyMs, method?, url?, bodyBytes?}`.
  `method`, `url` and `bodyBytes` (#3634) say what the step sent and are absent for a step that sent nothing; `url` arrives masked by the engine and cut to 512 bytes.
  Listened for only when `onStep` is passed, since a load run never emits one.
- **`monitor`**: One scrape of the run's monitored endpoint - `{timestamp, series}`.
  Listened for only when `onMonitor` is passed.
  Interleaved with `metrics` ticks on one id space, so `Last-Event-ID` resume replays both in the order they happened.
- **`complete`**: The run reached a terminal status
- **`error`**: Connection error (triggers reconnection)
- **`open`**: Connection established
