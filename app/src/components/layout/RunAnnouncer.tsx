/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Says aloud that a run started, and how it ended (#3498). The pill, the
 * banner and the run tab change only on screen, and a run is long enough that
 * the user is often on another tab by the time it ends.
 *
 * Mounted once by `Shell`, not by the dashboard or the run tab: only one tab's
 * surface is mounted at a time and the history view remounts per run, and a
 * live region has to be in the DOM, empty, before the change it announces. It
 * is therefore an `sr-only` region rather than the visible line, the deliberate
 * exception to `docs/design-system.md`'s rule. Polite, for the reason
 * `ResponseAnnouncer` gives.
 */

import { useState } from "react";
import { useDashboardStore } from "@/stores/dashboard-store";
import { useScenarioRunStore } from "@/stores/scenario-run-store";
import {
	dashboardAnnouncement,
	scenarioAnnouncement,
	type DashboardSnapshot,
	type ScenarioSnapshot,
} from "./run-announcement";

interface Heard {
	dashboard: DashboardSnapshot;
	scenario: ScenarioSnapshot;
	message: string;
	/** Bumped per message, so a repeat of the same words is still a change. */
	seq: number;
}

export function RunAnnouncer() {
	const dashboardRunId = useDashboardStore((s) => s.currentRunId);
	// Changes identity only on a transition, never on a tick.
	const phase = useDashboardStore((s) => s.phase);
	const scenarioRunId = useScenarioRunStore((s) => s.runId);
	const isStreaming = useScenarioRunStore((s) => s.isStreaming);
	const endedAs = useScenarioRunStore((s) => s.endedAs);
	// Only once ended, so a streaming run's batches do not re-render this.
	const endedCounts = useScenarioRunStore((s) => (s.endedAs ? s.summary.counts : null));

	const dashboard: DashboardSnapshot = { runId: dashboardRunId, phase };
	const scenario: ScenarioSnapshot = { runId: scenarioRunId, isStreaming, endedAs };

	// React's adjust-state-during-render pattern, as in `ResponseAnnouncer`: the
	// first render records where the runs stand and says nothing, and each later
	// move is compared with the last one heard.
	const [heard, setHeard] = useState<Heard>({ dashboard, scenario, message: "", seq: 0 });
	const moved =
		heard.dashboard.runId !== dashboard.runId ||
		heard.dashboard.phase !== dashboard.phase ||
		heard.scenario.runId !== scenario.runId ||
		heard.scenario.isStreaming !== scenario.isStreaming ||
		heard.scenario.endedAs !== scenario.endedAs;
	if (moved) {
		const said = [
			dashboardAnnouncement(heard.dashboard, dashboard),
			scenarioAnnouncement(heard.scenario, scenario, endedCounts),
		]
			.filter(Boolean)
			.join(". ");
		setHeard({
			dashboard,
			scenario,
			message: said || heard.message,
			seq: said ? heard.seq + 1 : heard.seq,
		});
	}

	return (
		// aria-atomic written out, as `ResponseAnnouncer` explains.
		<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
			<span key={heard.seq}>{heard.message}</span>
		</div>
	);
}
