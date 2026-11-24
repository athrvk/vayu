---
description: >-
  How the app handles HTTP, network and SSE errors, checks the engine's health and starts the engine.
---

# Errors and connection management

## Error Handling

### HTTP Errors

All HTTP errors are transformed to `ApiError`:

```typescript
try {
  await apiService.executeRequest(...);
} catch (error) {
  if (error instanceof ApiError) {
    console.error(error.userFriendlyMessage);
    console.error(error.statusCode);
    console.error(error.errorCode);
  }
}
```

### Network Errors

Network errors (timeout, connection failed) are caught and displayed:

```typescript
if (error.isTimeout) {
  // Show timeout message
} else if (error.isNetworkError) {
  // Show network error message
}
```

### SSE Errors

The SSE client does **not** reconnect by itself.
`EventSource` cannot set `Last-Event-ID` on a fresh connection, so the user's Reconnect passes the last frame it held as `?lastEventId=` instead; without it the engine would replay the topic from offset 0 and duplicate every tick already plotted (#3571).

- Transient errors (`CONNECTING`): left to the browser's own retry, which does carry `Last-Event-ID`
- Terminal errors (`CLOSED`): connection disposed and the close handler runs, which converges on `GET /runs/:id/report`

## Connection Management

### Health Checking

The app polls `/health` endpoint to verify engine connectivity, at one of two speeds depending on whether the last poll succeeded:

```typescript
useHealthQuery() // TIMING.HEALTH_RECONNECT_POLL_INTERVAL_MS (1s) while erroring,
                 // TIMING.HEALTH_CHECK_INTERVAL_MS (30s) once connected
```

The window loads alongside the engine rather than after it, so an ordinary launch spends its first seconds starting rather than connected; polling that state at the 30s cadence could leave a launch showing it for half a minute after the engine was already serving.
A poll that succeeds right after one that failed also triggers `queryClient.invalidateQueries()` once -
an engine that stopped with nothing starting costs collections, runs and config their two retries, a connection refused by a closed port is an `EngineUnreachableError` rather than an `ApiError`, and `refetchOnReconnect` only fires on the browser's online/offline event, which localhost never changes - so nothing else would ever revisit their error state once the engine came back.

A launch does not spend those retries.
While the start window below is open, the shared retry policy (`shouldRetryQuery` and `queryRetryDelay` in `lib/query-client.ts`, via `isEngineStartFailure`) keeps retrying a refused connection every `QUERY_CACHE.ENGINE_START_RETRY_DELAY_MS` (250ms) without counting it, so every query mounted at first paint -
the collection tree, the Launcher, a restored tab's request or run - stays loading beside the Dock's "Starting…" and loads within that delay of the engine listening.
Without that, they would settle into "Couldn't reach Vayu's engine" panes a few hundred milliseconds to three seconds into an ordinary launch, and flash them until the reconnect refetch above replaced them.
The failure still surfaces, on the same clock as the Dock: the first refused attempt after the window expires is not retried.
`requestDetailOptions` and `runDetailOptions` bring their own `retry`, so they compose `isEngineStartFailure` in themselves.

A failed poll does not mean `engineStatus` becomes `unreachable` outright: `engineStatusAfterFailedPoll` (`lib/engine-start-window.ts`) reads `starting` while an engine is known to be coming up and is still inside `TIMING.ENGINE_STARTUP_GRACE_MS` (45s) of the moment it began, and `unreachable` otherwise - past that window, or after an engine that had answered stops answering with nothing starting.
The moment it began is `engineStartWindow` on `engine-store`, opened by this hook on mount - which is when the main process spawns the engine and starts spending its own budget on the same wait - and again by `useEngineRestart` before it invokes the restart IPC, because a restart kills the daemon and spawns a fresh one that repeats the whole cold start with the port down for all of it (#1227).
Measuring from the hook's mount alone called every such restart a failure, since an engine had answered: the one this one replaced.
The restart opens the window and never writes `engineStatus`, so this hook remains the only thing that classifies; a restart the main process reports as failed closes the window again, and the next failed poll goes back to owing the user its reason.

A start failure the main process reports overrules that grace.
When every engine port is held, `useHealthQuery` reads `getEngineStartFailure()` on a failed poll, and a sentence there makes the status `unreachable` at once and keeps it there between polls, instead of "Starting…" for 45s over an engine nobody is starting (issue #2118).
The poll an engine answers clears it.

That 45s is the same budget the main process spends on a cold engine before it gives up and logs `EngineNotReadyError` (`ENGINE_HEALTH_POLL_BUDGET_MS` in `electron/constants.ts`) - it is the same question asked from the other side of the process boundary -
and since the two files' tsconfigs share no module graph, `health.test.ts` reads the constant out of `electron/constants.ts`'s source text and asserts it equals `TIMING.ENGINE_STARTUP_GRACE_MS`, so the two cannot drift apart unnoticed.

**Health Response:**
```typescript
{
  status: "ok",
  version: "0.3.0",
  workers: 8,
  // Optional (issue #922): present only when this engine startup restored the
  // database from its backup or started fresh because it could not. Absent on a
  // clean start, which is also what a genuine first run gives.
  recovery?: {
    outcome: "restored_from_backup" | "started_fresh_quarantined"
           | "backup_also_corrupt" | "deleted_corrupt",
    at: 1755870000000,   // epoch ms
    databasePath: "/home/someone/.local/share/vayu/vayu.db",
    // Optional (issue #984): where the unopenable database was moved to, when
    // it was moved rather than deleted. Absent for `deleted_corrupt`.
    quarantinedPath?: "/home/someone/.local/share/vayu/vayu.db.corrupt-1755870000000"
  }
}
```

`useHealthQuery` mirrors `recovery` onto `engine-store`, and `RecoveryBanner` is its only reader - it is the one thing that tells the user their data was restored or wiped, and the only place the quarantined file and its `sqlite3 ... .recover` command are named.
Its copy is a `Record` over the outcome union, so an outcome the engine adds without copy for it fails `pnpm type-check` rather than being announced as whichever branch came last.

### Engine Startup

The Electron main process (`electron/sidecar.ts`) manages engine lifecycle:
- Spawns engine process on app start, alongside creating the window rather than before it - first paint does not wait on the engine
- Monitors health via `/health` endpoint, on a ramped poll that leaves a live-but-slow engine to the renderer's own health poll instead of quitting the app
- Handles graceful shutdown on app quit
