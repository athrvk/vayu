/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ScenarioRunService - keeps a collection run's live stream alive across
 * navigation, the way `LoadTestService` does for a load run.
 *
 * The two share `sseClient`, which is a singleton holding one `EventSource`,
 * so they cannot stream at once - starting a scenario run stops whatever the
 * client was attached to. That is the engine's model too (a run at a time from
 * this app), not a limitation introduced here.
 *
 * There is no throttling here and there is deliberately none: a load run emits
 * ticks at 10 Hz, while a scenario emits one event per step execution - a rate
 * bounded by how fast the requests themselves come back.
 */

import { sseClient } from "./sse-client";
import { apiService } from "./api";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { useScenarioRunStore } from "@/stores/scenario-run-store";

class ScenarioRunService {
	private activeRunId: string | null = null;

	/** Attach to a scenario run's stream and push its steps into the store. */
	startMonitoring(runId: string): void {
		if (this.activeRunId === runId) return;

		this.activeRunId = runId;
		useScenarioRunStore.getState().startRun(runId);

		// Connect immediately: the engine retains a replayable topic per run, so
		// even a sequence that finishes before we attach replays from offset 0.
		sseClient.connect(
			runId,
			// A scenario run publishes no `metrics` ticks - its work is
			// sequential, so a per-tick aggregate would describe one request at a
			// time. The handler exists because the client's signature requires
			// one; there is nothing for it to do.
			() => {},
			this.handleError.bind(this),
			this.handleClose.bind(this),
			(step) => useScenarioRunStore.getState().addStep(step)
		);
	}

	/*
	 * There is deliberately no `stopMonitoring` here, unlike `LoadTestService`.
	 * The stream ends on its own - the engine sends `complete` when the run
	 * reaches a terminal status - and that holds for a *stopped* run too: the
	 * scenario runner observes `should_stop` per step, settles the run to
	 * `Stopped` and closes the topic, so the runner tab's Stop control gets its
	 * terminal event through the same path a run that finished normally does.
	 * A detach method with no caller is surface that cannot be verified.
	 */

	private handleError(error: Error): void {
		console.error("[ScenarioRunService] SSE error:", error);
		useScenarioRunStore.getState().setError(error.message);
	}

	/**
	 * The stream ended. The run has reached a terminal status, so its stored
	 * step rows are now the complete record - invalidating the report and the
	 * run itself is what flips the view from the live list to that record.
	 */
	private async handleClose(): Promise<void> {
		const runId = this.activeRunId;
		this.activeRunId = null;
		useScenarioRunStore.getState().setStreaming(false);
		if (!runId) return;

		// Through the cache, not a bare fetch: the run tab reads these exact
		// keys, so a fetch that bypassed them would leave the pane on the stale
		// "running" copy until something else invalidated it.
		await Promise.all([
			queryClient
				.invalidateQueries({ queryKey: queryKeys.runs.detail(runId) })
				.catch((e: unknown) => console.warn("[ScenarioRunService] run refresh failed", e)),
			queryClient
				.fetchQuery({
					queryKey: queryKeys.runs.report(runId),
					queryFn: () => apiService.getRunReport(runId),
					/*
					 * `staleTime: 0`, and the whole fix rides on it. The run tab
					 * mounts the moment the run starts and fetches this key
					 * immediately, when the engine has stored no step rows yet -
					 * they are written in one batch at the end - so the cache
					 * holds a report with an empty `results[]`, seconds old.
					 * `fetchQuery` under the hook's own five-minute
					 * `RUNS_STALE_TIME_MS` would find that entry fresh and resolve
					 * from it without a request, leaving the step list on the live
					 * rows forever: every step expanded into an empty panel,
					 * because only a stored row carries the exchange.
					 *
					 * This is the one fetch in the app that knows the data just
					 * changed, so it is the one that must not honour the cache.
					 */
					staleTime: 0,
				})
				.catch((e: unknown) => console.warn("[ScenarioRunService] report fetch failed", e)),
		]);

		// The run's row in History still says "running" until the next 5s poll,
		// and once the user has paged the list that poll is off.
		void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
		// The context bar's Last run section says the same thing, from its own
		// key family (`lastCollectionRuns`), which the prefix above does not
		// reach - and it is not polled at all, so without this it stays on
		// "Running" for the rest of the session.
		void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lastCollectionRuns() });
	}
}

export const scenarioRunService = new ScenarioRunService();
