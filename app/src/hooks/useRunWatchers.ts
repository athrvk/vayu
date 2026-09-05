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
 * one path that already means "watch this run".
 *
 * Mounted once in `App.tsx`, beside `useMcpDataInvalidation`, for the same
 * reason: the event names a run, not a screen, and a listener that came and went
 * with a view would miss the runs this exists for. Absent outside Electron,
 * where there is no MCP server to hear from.
 */

import { useEffect } from "react";
import { loadTestService } from "@/services/load-test-service";
import { scenarioRunService } from "@/services/scenario-run-service";
import { useDashboardStore } from "@/stores/dashboard-store";

export function useRunWatchers(): void {
	useEffect(() => {
		if (!window.electronAPI?.onMcpDataChanged) return;
		return window.electronAPI.onMcpDataChanged((event) => {
			const started = event.startedRun;
			// Every other `run` event names a run that already exists - a stop, a
			// baseline change, a delete - and none of them is something to attach
			// a stream to.
			if (!started) return;
			if (started.kind === "load") {
				// Registered before the stream, exactly as the app's own callers do:
				// `startMonitoring` writes metrics into this store and states that
				// its caller has already pointed the store at the run. No config
				// rides along - the agent's arguments are the engine's business,
				// and the dashboard reads a run with no declared duration as one
				// whose bar has no denominator yet, which is what it is.
				useDashboardStore.getState().startRun(started.runId);
				loadTestService.startMonitoring(started.runId);
			} else {
				scenarioRunService.startMonitoring(started.runId);
			}
		});
	}, []);
}
