/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one answer to "may a load run start now" (#3351), which the builder, the
 * Run Collection dialog and an agent's run each ask. Their own suites pin that
 * they ask it; this pins what it answers.
 */

import { afterEach, describe, expect, it } from "vitest";
import { useDashboardStore, type DashboardPhase } from "./dashboard-store";
import { useScenarioRunStore } from "./scenario-run-store";
import {
	canReattachLoadRun,
	canStartLoadRun,
	loadRunGateOf,
	reattachGateOf,
	runningRunSentence,
	runningRunTab,
	type RunningRun,
} from "./run-gate";

const NO_SCENARIO = { runId: null, isStreaming: false };

function dashboardIn(phase: DashboardPhase) {
	return { currentRunId: "run_1", phase, requestInfo: null };
}

afterEach(() => {
	useDashboardStore.setState({ currentRunId: null, phase: { phase: "idle" }, requestInfo: null });
	useScenarioRunStore.setState({ runId: null, isStreaming: false });
});

describe("loadRunGateOf", () => {
	// Mutation check: read `phase === "streaming"` instead of
	// `isDashboardRunLive` and the lost-stream row opens the gate beside a run
	// the engine is still executing - the builder guard defect #3351 names.
	it.each<[string, DashboardPhase]>([
		["streaming", { phase: "streaming" }],
		["streamLost", { phase: "streamLost", message: "socket closed" }],
		["awaitingReport", { phase: "awaitingReport", stopped: false }],
	])("refuses while the dashboard's run is %s", (_name, phase) => {
		expect(loadRunGateOf(dashboardIn(phase), NO_SCENARIO)).toEqual({
			ok: false,
			running: { kind: "load", runId: "run_1", label: null },
		});
	});

	it.each<[string, DashboardPhase]>([
		["idle", { phase: "idle" }],
		["stopped and awaiting its report", { phase: "awaitingReport", stopped: true }],
		["past a failed report fetch", { phase: "reportError", message: "x", stopped: false }],
	])("opens while the dashboard's run is %s", (_name, phase) => {
		expect(loadRunGateOf(dashboardIn(phase), NO_SCENARIO)).toEqual({ ok: true });
	});

	it("names the dashboard's run by the request it targets", () => {
		const gate = loadRunGateOf(
			{
				currentRunId: "run_1",
				phase: { phase: "streaming" },
				requestInfo: { method: "GET", url: "https://api.example.com/items" },
			},
			NO_SCENARIO
		);
		expect(gate).toMatchObject({ running: { label: "GET https://api.example.com/items" } });
	});

	// Mutation check: drop the scenario branch and a load run takes the one
	// stream client from a collection run without a word.
	it("refuses while a collection run streams", () => {
		const gate = loadRunGateOf(dashboardIn({ phase: "idle" }), {
			runId: "coll_1",
			isStreaming: true,
		});
		expect(gate).toEqual({
			ok: false,
			running: { kind: "collection", runId: "coll_1", label: null },
		});
	});

	it("opens once the collection run's stream has ended", () => {
		const gate = loadRunGateOf(dashboardIn({ phase: "idle" }), {
			runId: "coll_1",
			isStreaming: false,
		});
		expect(gate).toEqual({ ok: true });
	});
});

describe("reattachGateOf", () => {
	// Mutation check: answer it with `loadRunGateOf` and Reconnect is refused
	// for the very run it exists to re-attach - the dashboard's own, live.
	it("never asks about the dashboard's own run", () => {
		useDashboardStore.getState().startRun("run_1");
		useDashboardStore.getState().streamLost("run_1", "socket closed");
		expect(canReattachLoadRun()).toEqual({ ok: true });
	});

	it("refuses while a collection run streams, naming it", () => {
		expect(reattachGateOf({ runId: "coll_1", isStreaming: true })).toEqual({
			ok: false,
			running: { kind: "collection", runId: "coll_1", label: null },
		});
		expect(reattachGateOf({ runId: "coll_1", isStreaming: false })).toEqual({ ok: true });
		expect(reattachGateOf(NO_SCENARIO)).toEqual({ ok: true });
	});
});

describe("canStartLoadRun", () => {
	it("reads both stores as they stand", () => {
		expect(canStartLoadRun()).toEqual({ ok: true });

		useScenarioRunStore.getState().startRun("coll_1");
		expect(canStartLoadRun()).toMatchObject({ ok: false, running: { kind: "collection" } });

		useScenarioRunStore.getState().setStreaming("coll_1", false);
		useDashboardStore.getState().startRun("run_1");
		expect(canStartLoadRun()).toMatchObject({ ok: false, running: { kind: "load" } });
	});
});

describe("the refusal", () => {
	const load: RunningRun = { kind: "load", runId: "run_1", label: "GET https://a.test/x" };
	const collection: RunningRun = { kind: "collection", runId: "coll_1", label: null };

	it("says which run holds the stream", () => {
		expect(runningRunSentence(load)).toBe(
			"A load test of GET https://a.test/x is already running."
		);
		expect(runningRunSentence({ ...load, label: null })).toBe(
			"A load test is already running."
		);
		expect(runningRunSentence(collection)).toBe("A collection run is already running.");
	});

	it("opens the surface that shows the run live", () => {
		expect(runningRunTab(load)).toEqual({ type: "dashboard", entityId: null });
		expect(runningRunTab(collection)).toEqual({ type: "run", entityId: "coll_1" });
	});
});
