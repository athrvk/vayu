/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useCallback, useState } from "react";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { apiService } from "@/services/api";
import { loadTestService } from "@/services/load-test-service";
import { useDashboardStore } from "@/stores/dashboard-store";
import type { RunningRun } from "@/stores/run-gate";
import { useToastStore } from "@/stores/toast-store";

/**
 * The dashboard's run: the dashboard shows Stopping, the stream is detached,
 * and the store settles the run as stopped, none of which the engine's answer
 * does by itself. The dashboard's `isStopping` is store state because its
 * header reads it, so it is raised and lowered here, not in the hook.
 */
async function stopDashboardRun(runId: string): Promise<void> {
	const { setStopping, stopRun } = useDashboardStore.getState();
	setStopping(runId, true);
	try {
		await apiService.stopRun(runId);
		loadTestService.stopMonitoring();
		stopRun(runId);
	} finally {
		setStopping(runId, false);
	}
}

/**
 * A run no dashboard owns: a collection run, or a History tab's run with no
 * stream of its own.
 *
 * A tab attached to the run's stream hears the end again through `complete`,
 * and its service refreshes these keys on close. A tab that is *not* attached
 * gets no such event, so without this its run would sit on "running" - still
 * offering a Stop for something already stopped, and never loading what the run
 * just wrote.
 */
async function stopRunAndRefresh(runId: string): Promise<void> {
	await apiService.stopRun(runId);
	await queryClient.invalidateQueries({ queryKey: queryKeys.runs.detail(runId) });
	await queryClient.invalidateQueries({ queryKey: queryKeys.runs.report(runId) });
	void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
	void queryClient.invalidateQueries({ queryKey: queryKeys.runs.requestRuns() });
}

/**
 * Stop the live run a `RunningRun` names, the run id supplied per call: the
 * Run Collection dialog's Stop (#3381) learns which run it holds only from the
 * gate, and the dashboard's own Stop is the same call.
 *
 * `stop` resolves once the stop and what follows it are done and never throws.
 * A failure is a toast with a retry: the run is still sending requests, so the
 * retry is the reason for telling them at all, and without it a click that
 * failed is indistinguishable from one that did nothing.
 */
export function useStopLiveRun(): {
	stop: (running: RunningRun) => Promise<void>;
	isStopping: boolean;
} {
	const showToast = useToastStore((s) => s.showToast);
	const [isStopping, setIsStopping] = useState(false);

	// A named function expression so the retry can call itself: a `const`
	// referencing its own initializer trips react-hooks/immutability.
	const stop = useCallback(
		async function attemptStop(running: RunningRun): Promise<void> {
			setIsStopping(true);
			try {
				await (running.kind === "load"
					? stopDashboardRun(running.runId)
					: stopRunAndRefresh(running.runId));
			} catch (error) {
				console.error("Failed to stop run:", error);
				showToast({
					message:
						error instanceof Error
							? `Couldn't stop the run - ${error.message}`
							: "Couldn't stop the run",
					variant: "error",
					action: {
						label: "Try again",
						altText: "Try stopping the run again",
						onClick: () => void attemptStop(running),
					},
				});
			} finally {
				setIsStopping(false);
			}
		},
		[showToast]
	);

	return { stop, isStopping };
}
