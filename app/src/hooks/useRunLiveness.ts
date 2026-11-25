/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether `runId` is live, the one answer a view of a stored run reads (#3351): its stored status,
 * joined with whichever live surface in this window holds the run, the dashboard
 * (`isDashboardRunLive`, so a lost stream counts) or a collection run's stream. See `isRunLive` for
 * which side wins.
 *
 * One answer outranks the stored status: a run the engine's process ended under (#3605). Its stored
 * status is whatever the cache last read, `running`, from an engine that no longer exists, and
 * nothing can move it until a restarted engine settles the run, so reading it would keep Running
 * and Stop on a run that cannot be stopped.
 *
 * Reads, never owns: the streams belong to `LoadTestService` and `ScenarioRunService`, and the
 * caller passes the status it already holds from `useRunQuery` or a runs list rather than this
 * adding a second observer, and a second poll, of the same run.
 */

import { useDashboardStore, isDashboardRunLive } from "@/stores/dashboard-store";
import { useScenarioRunStore } from "@/stores/scenario-run-store";
import { isRunLive } from "@/lib/run-status";

export function useRunLiveness(
	runId: string | null | undefined,
	storedStatus: string | null | undefined
): boolean {
	const dashboardLive = useDashboardStore(
		(s) => !!runId && s.currentRunId === runId && isDashboardRunLive(s.phase)
	);
	const scenarioLive = useScenarioRunStore((s) => !!runId && s.runId === runId && s.isStreaming);
	const dashboardEngineStopped = useDashboardStore(
		(s) => !!runId && s.currentRunId === runId && s.phase.phase === "engineStopped"
	);
	const scenarioEngineStopped = useScenarioRunStore(
		(s) => !!runId && s.runId === runId && s.endedByEngineStop
	);
	if (dashboardEngineStopped || scenarioEngineStopped) return false;
	return isRunLive(storedStatus, dashboardLive || scenarioLive);
}
