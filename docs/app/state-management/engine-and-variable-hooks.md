---
description: >-
  The custom hooks for composing, executing and stopping a request, for live metrics and for variable resolution.
---

# Custom Hooks

## `useEngine()` - Compose, Execute, Stop

Wraps the three engine calls that are not queries, with `error` for the caller to render.
Whether a send is in flight is not here: the request builder holds that per request (`RequestBuilderProvider`'s `isExecuting`, #3352).

**API:**
```typescript
const {
  composeRequest: (params: ComposeRequestRequest) => Promise<ComposedRequest>
  executeRequest: (params: ExecuteRequestRequest, environmentId?: string, signal?: AbortSignal) => Promise<SanityResult | null>  // null once `signal` cancelled it
  stopLoadTest: (runId: string) => Promise<boolean>
  error: string | null
} = useEngine();
```

- **`composeRequest`** is `POST /compose` - the engine resolves `{{variables}}` and `inherit` auth and hands back the execute-ready payload (issue #226).
  It **throws** on failure; the caller surfaces it like an execute failure.
- **`executeRequest`** takes an *already composed* payload.
  It never throws: a failure comes back as a `SanityResult` with `status: 0` and an `errorCode`, because the response pane renders the failure the same way it renders a response.
- **`stopLoadTest`** returns `false` rather than throwing when the engine refuses.
- **Starting a load test is not here.**
  The request builder composes, then calls `apiService.startLoadTest()` (`POST /runs`), `useDashboardStore().startRun()` and `loadTestService.startMonitoring()` in that order, at one call site - registering the run before attaching the stream is what keeps the dashboard from showing a stream with no run behind it.

## Live Metrics Streaming - `loadTestService` + `sseClient`

There is **no React hook that owns the metrics stream**, on purpose.
The stream has to outlive whichever view is mounted (navigate away from the dashboard mid-run and the run keeps streaming), so it is a module singleton, and the hooks that ask about a run (`useRunLiveness`, `useCanStartLoadRun`) only read the stores it writes: `services/load-test-service.ts` holds the state machine and `services/sse-client.ts` the `EventSource`.

```typescript
import { loadTestService } from "@/services/load-test-service";

loadTestService.startMonitoring(runId);  // after useDashboardStore().startRun(...)
loadTestService.stopMonitoring();
```

- Connects to `GET /runs/:runId/live`, a **replayable** tick topic.
  A first attach reads it from offset 0, so a run that finishes before the client attaches, or one attached to mid-run, rebuilds the charts rather than starting blank.
  A re-attach to the run the client already holds frames for (Reconnect, or the dashboard's re-attach on mount) resumes instead: `SSEClient` records the `lastEventId` of every frame it receives - ticks, steps, plans and monitor scrapes share one id sequence - and `connect` sends the last one as `?lastEventId=`, so the engine replays only what the dashboard has not seen (#3571).
  A resume keeps `currentMetrics`, so the header does not flash zero.
  The client holds one slot, for the run it last served: attaching another run replaces it, and a run attached again after that starts from offset 0.
- Every tick is buffered; commits into `useDashboardStore().addMetricsBatch()` are throttled to `METRICS_UI_THROTTLE_MS` so `historicalMetrics` keeps the full 10 Hz signal while renders stay bounded.
  The buffer, the leading edge and the trailing timer are `services/throttled-batcher.ts`, shared with `ScenarioRunService` (issue #1206) and with `useExecutionEvents` (issue #1158) - a monitor scrape has no timer of its own and rides the next tick's flush, which is why that second buffer stays in the service rather than moving into the batcher.
- The engine sends an explicit `complete` event, so a `CLOSED` readyState is a genuine failure.
  **Nothing reconnects by itself**: `EventSource` cannot set `Last-Event-ID` on a fresh connection, which is why the resume point travels as `?lastEventId=` when the user's Reconnect asks.
  The browser's own intra-connection retry does carry the header and is left alone; once the browser gives up, the service converges on `GET /runs/:id/report` in its close handler, and Reconnect is the way back to the stream.
  A close flushes the ticks buffered at the drop (their ids were recorded as they arrived, so the resume starts after them), and a release that discards them (`stopMonitoring`, a superseded run) is for a run that is not resumed.

## `useVariableResolver()` - Variable Resolution

Resolves `{{variableName}}` patterns in strings and objects using environment, collection, and global variables.

**API:**
```typescript
const {
  resolveString: (input: string) => string
  resolveField: (input: string, context?: DataFieldContext) => BoundField
  resolveObject: <T>(obj: T) => T
  getVariable: (name: string) => ResolvedVariable | null
  getAllVariables: () => Record<string, ResolvedVariable>
  getVariableOrigins: (name: string) => VariableOrigin[]
} = useVariableResolver({ collectionId?: string; boundRow?: DataFileRow });

// resolveString takes an optional per-call row (issue #1074), for the one
// caller that resolves for several requests at once - the tab strip.
resolveString(input: string, row?: DataFileRow): string
```

`resolveField` is the preview of one field of a known kind (issue #2639):
`context` is `plain` (the default), `url`, `header`, `json` or `xml`, and with `boundRow` set a cell is written for it as the engine's bind writes it - escaped in a JSON string or XML, encoded in a URL - while `refusals` carries why the send would refuse the row over the field (a cell in an XML comment, a line break bound into a header), naming it "the picked row".
Without a row it is `resolveString`'s text with nothing refused.
The request builder's context carries it beside `resolveString`, and `VariableSupport` in its place; the Body tab's Resolved view and the key/value peeks read it.

**Resolution Priority (highest to lowest):**
1. Bound data row (bare column names) - only while `boundRow` is passed and a row is actually picked (issue #1062)
2. Environment variables
3. Collection variables
4. Global variables

Collection scope comes from the `collectionId` option and nowhere else - a caller that passes none resolves against globals + environment.
See `docs/app/variable-resolution.md` for why the session-store fallback was removed.

`boundRow` is optional and additive: without it `resolveString` / `resolveObject` resolve exactly as before (composition only, both a bound column and `{{data.column}}` deferred).
With it, they resolve through `resolveTemplateWithRow` instead, so a bare bound column and `{{data.column}}` both read the row - the request builder's provider is the one caller that passes it, deriving it from the picked-row index.
See `docs/app/variable-resolution.md` for the tier and its rules.

`resolveString`'s second argument is the same row named per call instead of per hook.
It exists for `useTabDescriptors`, which labels every open tab from a single resolver and therefore cannot name one row for the whole of it; it reads the row out of `useBoundRowStore` for the tab it is labelling.
Both spellings render a row's cells through the same helper, so the two cannot disagree.

**The environment is the one scope no option names.**
It is *not* passed in: the hook reads `useSessionStore().activeEnvironmentId` itself, so every caller resolves against the environment the user has actually selected and no caller can scope a preview to a different one.
This page documented an `environmentId` option for a while; nothing has ever accepted one.
The two scopes are asymmetric on purpose - the active environment is app-wide state, while the collection is a property of whatever the caller is rendering.

`ResolvedVariable` carries `sourceId` / `sourceName` - the specific environment or collection the winning value came from (absent for `global`).

`getVariableOrigins` returns **every** definition of a name, lowest precedence first, including disabled ones that never resolve.
Display-only; the variable popover renders it as "also defined".
Since issue #1064 it also carries the bound row on top when one answers the name, taking `winner` from whichever scope it beat.
See `docs/app/variable-resolution.md` for why the losers are kept and why the MCP copy is not given the same accessor.
