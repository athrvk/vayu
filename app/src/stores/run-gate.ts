/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether a load run may start now, the one answer every entry point asks
 * (#3351): the request builder, the Run Collection dialog and a run an MCP
 * agent started. The engine sets no limit on concurrent runs; this is the
 * renderer's policy, and it holds because both live surfaces read one stream.
 *
 * Two stores answer it, not one. `sseClient` holds a single `EventSource`, so
 * a load run attaching takes the stream from a collection run as surely as
 * from another load run, and the run it took keeps executing on the engine
 * with no live view. A collection run's own start is not gated: it takes the
 * stream from a live load run openly, through the dashboard's lost-stream
 * callout (#1417).
 */

import { useMemo } from "react";
import {
	isDashboardRunLive,
	useDashboardStore,
	type DashboardPhase,
	type LoadTestRequestInfo,
} from "./dashboard-store";
import { useScenarioRunStore } from "./scenario-run-store";
import type { TabLocation } from "./tabs-store";

/** The run that holds the stream, and which surface shows it. */
export interface RunningRun {
	/** `load`: the dashboard's run; `collection`: a collection run's tab. */
	kind: "load" | "collection";
	runId: string;
	/** What the run is aimed at, when the store holds it ("GET https://..."). */
	label: string | null;
}

export type LoadRunGate = { ok: true } | { ok: false; running: RunningRun };

/** The fields of `dashboard-store` the gate reads. */
interface DashboardRun {
	currentRunId: string | null;
	phase: DashboardPhase;
	requestInfo: LoadTestRequestInfo | null;
}

/** The fields of `scenario-run-store` the gate reads. */
interface ScenarioRun {
	runId: string | null;
	isStreaming: boolean;
}

const OPEN: LoadRunGate = { ok: true };

/** The gate's rule over the two stores' fields, free of either store. */
export function loadRunGateOf(dashboard: DashboardRun, scenario: ScenarioRun): LoadRunGate {
	if (dashboard.currentRunId && isDashboardRunLive(dashboard.phase)) {
		const info = dashboard.requestInfo;
		return {
			ok: false,
			running: {
				kind: "load",
				runId: dashboard.currentRunId,
				label: info ? `${info.method} ${info.url}` : null,
			},
		};
	}
	if (scenario.runId && scenario.isStreaming) {
		return { ok: false, running: { kind: "collection", runId: scenario.runId, label: null } };
	}
	return OPEN;
}

/** The gate as the stores stand now, for an event handler or a service. */
export function canStartLoadRun(): LoadRunGate {
	return loadRunGateOf(useDashboardStore.getState(), useScenarioRunStore.getState());
}

/** The gate for a component that renders its answer and follows it as runs end. */
export function useCanStartLoadRun(): LoadRunGate {
	const currentRunId = useDashboardStore((s) => s.currentRunId);
	// Changes identity only on a transition, never on a tick.
	const phase = useDashboardStore((s) => s.phase);
	const requestInfo = useDashboardStore((s) => s.requestInfo);
	const runId = useScenarioRunStore((s) => s.runId);
	const isStreaming = useScenarioRunStore((s) => s.isStreaming);
	return useMemo(
		() => loadRunGateOf({ currentRunId, phase, requestInfo }, { runId, isStreaming }),
		[currentRunId, phase, requestInfo, runId, isStreaming]
	);
}

/** "A load test of GET https://... is already running.", the refusal's sentence. */
export function runningRunSentence(running: RunningRun): string {
	if (running.kind === "collection") return "A collection run is already running.";
	return running.label
		? `A load test of ${running.label} is already running.`
		: "A load test is already running.";
}

/** The tab that shows the running run live. */
export function runningRunTab(running: RunningRun): TabLocation {
	return running.kind === "load"
		? { type: "dashboard", entityId: null }
		: { type: "run", entityId: running.runId };
}
