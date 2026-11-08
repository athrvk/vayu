/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Watch a run an MCP agent started, as if the app had started it (issue #1419).
 *
 * Everything a run does in the background - the OS progress indicator (#1362),
 * the keep-awake hold (#1357) and the finished/failed notification (#1358) -
 * lives inside `LoadTestService` and `ScenarioRunService`, and both begin at
 * `startMonitoring`. Until this hook existed only a renderer surface called it:
 * the dashboard and the Run Collection dialog. A run handed to an agent
 * therefore painted no taskbar bar, held no wake lock and said nothing when it
 * ended, until its dashboard tab was opened - and the user who hands a long run
 * to an agent is exactly the user who is not looking at the window.
 *
 * The fix is deliberately not a second copy of the run lifecycle in the main
 * process: main says only *that* a run started and which service owns it
 * (`startedRun` on the `mcp:data-changed` event), and the renderer enters the
 * one path that already means "watch this run". As for any other load run,
 * that path is open only while `canStartLoadRun` says so (#3351).
 *
 * Mounted once in `App.tsx`, beside `useMcpDataInvalidation`, for the same
 * reason: the event names a run, not a screen, and a listener that came and went
 * with a view would miss the runs this exists for. Absent outside Electron,
 * where there is no MCP server to hear from.
 */

import { useEffect } from "react";
import { loadTestService } from "@/services/load-test-service";
import { scenarioRunService } from "@/services/scenario-run-service";
import { apiService } from "@/services/api";
import { useDashboardStore } from "@/stores/dashboard-store";
import { canStartLoadRun } from "@/stores/run-gate";
import { useTabsStore } from "@/stores/tabs-store";
import { useToastStore } from "@/stores/toast-store";
import { loadConfigFromSnapshot, requestInfoFromSnapshot } from "@/lib/run-config-snapshot";

/**
 * Give the dashboard the config an agent's run was started with, read from the
 * run's stored snapshot (issue #1935).
 *
 * Best effort: the run is already being watched, and a row that cannot be read
 * leaves the dashboard as it was. It must not reach `streamLost`, which raises the
 * lost-stream callout for a stream that is fine. A response that arrives after
 * another run took the dashboard is dropped rather than written over it.
 */
async function configureFromRunRow(runId: string): Promise<void> {
	try {
		const snapshot = (await apiService.getRun(runId)).configSnapshot;
		if (!snapshot || useDashboardStore.getState().currentRunId !== runId) return;
		useDashboardStore
			.getState()
			.setRunConfig(loadConfigFromSnapshot(snapshot), requestInfoFromSnapshot(snapshot));
	} catch {
		// Swallowed on purpose: the dashboard without a config is how this run
		// looked before the row was read, and nothing else depends on it.
	}
}

/**
 * Watch an agent's load run: the dashboard, the stream, and the config from
 * its row. Registered before the stream, exactly as the app's own callers do:
 * `startMonitoring` writes metrics into the store and states that its caller
 * has already pointed the store at the run. The agent's arguments are not on
 * the event, so the config follows from the run's row once it is read.
 */
function adoptLoadRun(runId: string): void {
	useDashboardStore.getState().startRun(runId);
	loadTestService.startMonitoring(runId);
	void configureFromRunRow(runId);
}

/**
 * The agent's load run arrived while another run holds the stream
 * (`canStartLoadRun`, #3351). The engine has already started it, so refusing
 * is not on offer; what the app declines is taking the dashboard from the run
 * the user is watching. The agent's run executes unwatched, its History row
 * converges on the runs poll, and the toast is how the user hears of it.
 */
function announceUnwatchedLoadRun(runId: string): void {
	useToastStore.getState().showToast({
		message: "An agent started a load test while another run is live, so it has no live view.",
		variant: "warning",
		action: {
			label: "View run",
			altText: "Open the agent's load test",
			onClick: () => useTabsStore.getState().openTab({ type: "run", entityId: runId }),
		},
	});
}

export function useRunWatchers(): void {
	useEffect(() => {
		if (!window.electronAPI?.onMcpDataChanged) return;
		return window.electronAPI.onMcpDataChanged((event) => {
			const started = event.startedRun;
			// Every other `run` event names a run that already exists - a stop, a
			// baseline change, a delete - and none of them is something to attach
			// a stream to.
			if (!started) return;
			if (started.kind !== "load") {
				scenarioRunService.startMonitoring(started.runId);
				return;
			}
			if (canStartLoadRun().ok) adoptLoadRun(started.runId);
			else announceUnwatchedLoadRun(started.runId);
		});
	}, []);
}
