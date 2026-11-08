/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether `runId` is live, the one answer a view of a stored run reads (#3351):
 * its stored status, joined with whichever live surface in this window holds
 * the run - the dashboard (`isDashboardRunLive`, so a lost stream counts) or a
 * collection run's stream. See `isRunLive` for which side wins.
 *
 * Reads, never owns: the streams belong to `LoadTestService` and
 * `ScenarioRunService`, and the caller passes the status it already holds from
 * `useRunQuery` or a runs list rather than this adding a second observer, and
 * with it a second poll, of the same run.
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
	return isRunLive(storedStatus, dashboardLive || scenarioLive);
}
