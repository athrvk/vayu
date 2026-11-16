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
 * A screen-reader user hears a run start and end (#3498). Driven through the
 * real stores, by the same writers the services call, so the transitions are
 * the ones the app makes. jsdom speaks nothing: what is proven is that the
 * region is mounted empty and that its text changes to the right sentence.
 *
 * Mutation checks: keep the region's old message (drop `said` from
 * `setHeard`) and every announcing case reddens; drop the same-stage guard in
 * `dashboardAnnouncement` and the stop-once case does; announce "started" for
 * the same run and the Retry case does; drop the verdict from `loadTestEnded`
 * and the four ending cases do; drop `spokenSymbols` and the less-than case
 * does. Removing `<RunAnnouncer />` from `Shell` reddens
 * `shell-tab-identity.test.tsx`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { RunReport, ScenarioStepEvent } from "@/types";
import { useDashboardStore } from "@/stores/dashboard-store";
import { useScenarioRunStore } from "@/stores/scenario-run-store";
import { RunAnnouncer } from "./RunAnnouncer";

const DASHBOARD_INITIAL = useDashboardStore.getState();
const SCENARIO_INITIAL = useScenarioRunStore.getState();

function report(
	status: string,
	checks: Array<[metric: string, passed: boolean]> = [],
	errorRate = 0
): RunReport {
	const failed = checks.filter(([, passed]) => !passed).length;
	return {
		metadata: { status },
		summary: { totalRequests: 100, errorRate },
		...(checks.length > 0
			? {
					thresholdValidation: {
						checks: checks.map(([metric, passed]) => ({ metric, limit: 100, passed })),
						passed: checks.length - failed,
						failed,
						verdict: failed === 0 ? "passed" : "failed",
					},
				}
			: {}),
	} as unknown as RunReport;
}

function step(stepIndex: number, outcome: ScenarioStepEvent["outcome"]): ScenarioStepEvent {
	return {
		iteration: 0,
		stepIndex,
		name: `Step ${stepIndex}`,
		outcome,
		statusCode: 200,
		latencyMs: 5,
	};
}

function region(): HTMLElement {
	return screen.getByRole("status");
}

const dashboard = () => useDashboardStore.getState();
const scenario = () => useScenarioRunStore.getState();

describe("RunAnnouncer", () => {
	beforeEach(() => {
		useDashboardStore.setState(DASHBOARD_INITIAL, true);
		useScenarioRunStore.setState(SCENARIO_INITIAL, true);
	});

	it("is a polite, atomic region, mounted empty", () => {
		render(<RunAnnouncer />);
		expect(region()).toHaveAttribute("aria-live", "polite");
		expect(region()).toHaveAttribute("aria-atomic", "true");
		expect(region()).toHaveTextContent("");
	});

	it("says nothing on mount about a run already going", () => {
		dashboard().startRun("load_1");
		scenario().startRun("coll_1");
		render(<RunAnnouncer />);
		expect(region()).toHaveTextContent("");
	});

	it("announces a load test starting, and stays quiet through a lost stream and the report wait", () => {
		render(<RunAnnouncer />);
		act(() => dashboard().startRun("load_1"));
		expect(region()).toHaveTextContent("Load test started");
		const started = region().firstElementChild;

		act(() => dashboard().streamLost("load_1", "dropped"));
		act(() => dashboard().streamOpened("load_1"));
		act(() => dashboard().streamClosed("load_1"));
		// The same node: nothing was re-announced.
		expect(region().firstElementChild).toBe(started);
		expect(region()).toHaveTextContent("Load test started");
	});

	it("announces a completed load test with the banner's verdict", () => {
		render(<RunAnnouncer />);
		act(() => dashboard().startRun("load_1"));
		act(() => dashboard().streamClosed("load_1"));
		act(() =>
			dashboard().setFinalReport(
				"load_1",
				report("completed", [
					["latencyP95Ms", true],
					["maxErrorRatePct", true],
				])
			)
		);
		expect(region()).toHaveTextContent("Load test completed. Passed. All 2 budgets met");
	});

	it("names a completed run that missed a budget as failed", () => {
		render(<RunAnnouncer />);
		act(() => dashboard().startRun("load_1"));
		act(() =>
			dashboard().setFinalReport("load_1", report("completed", [["latencyP99Ms", false]]))
		);
		expect(region()).toHaveTextContent(
			"Load test completed. Failed. 1 of 1 budget missed: p99"
		);
	});

	it("speaks a rate that rounds to nothing as less than, not as a bare figure", () => {
		render(<RunAnnouncer />);
		act(() => dashboard().startRun("load_1"));
		act(() => dashboard().setFinalReport("load_1", report("completed", [], 0.01)));
		expect(region()).toHaveTextContent(
			"Load test completed. Not judged. No budgets set. less than 0.1% errors"
		);
	});

	it("announces a failed load test with its reason", () => {
		render(<RunAnnouncer />);
		act(() => dashboard().startRun("load_1"));
		act(() => dashboard().setFinalReport("load_1", report("failed")));
		expect(region()).toHaveTextContent("Load test failed. The run failed before it finished");
	});

	it("announces a stop once, when the engine confirms it, not again when the report lands", () => {
		render(<RunAnnouncer />);
		act(() => dashboard().startRun("load_1"));
		act(() => dashboard().stopRun("load_1"));
		expect(region()).toHaveTextContent("Load test stopped");
		const stopped = region().firstElementChild;

		act(() => dashboard().setFinalReport("load_1", report("stopped")));
		expect(region().firstElementChild).toBe(stopped);
	});

	it("corrects a stop the run's own verdict beat", () => {
		render(<RunAnnouncer />);
		act(() => dashboard().startRun("load_1"));
		act(() => dashboard().stopRun("load_1"));
		act(() => dashboard().setFinalReport("load_1", report("failed")));
		expect(region()).toHaveTextContent("Load test failed");
	});

	it("says a run ended when its report could not be read, and not that it restarted on Retry", () => {
		render(<RunAnnouncer />);
		act(() => dashboard().startRun("load_1"));
		act(() => dashboard().streamClosed("load_1"));
		act(() => dashboard().reportFailed("load_1", "engine gone"));
		expect(region()).toHaveTextContent("Load test finished. Couldn't load the run report");

		act(() => dashboard().retryReport("load_1"));
		expect(region()).toHaveTextContent("Couldn't load the run report");
	});

	it("re-announces the same words for a second run", () => {
		render(<RunAnnouncer />);
		act(() => dashboard().startRun("load_1"));
		const first = region().firstElementChild;
		act(() => dashboard().startRun("load_2"));
		expect(region()).toHaveTextContent("Load test started");
		expect(region().firstElementChild).not.toBe(first);
	});

	it("announces a collection run starting and ending with its step counts", () => {
		render(<RunAnnouncer />);
		act(() => scenario().startRun("coll_1"));
		expect(region()).toHaveTextContent("Collection run started");

		act(() => scenario().addSteps("coll_1", [step(0, "passed"), step(1, "failed")]));
		act(() => scenario().runEnded("coll_1", "completed"));
		expect(region()).toHaveTextContent("Collection run completed. 1 passed, 1 failed");
	});

	it.each([
		["stopped", "Collection run stopped"],
		["failed", "Collection run failed"],
	] as const)("announces a collection run that %s", (status, sentence) => {
		render(<RunAnnouncer />);
		act(() => scenario().startRun("coll_1"));
		act(() => scenario().runEnded("coll_1", status));
		expect(region()).toHaveTextContent(sentence);
	});

	it("says nothing when a collection run's stream drops without an ending", () => {
		render(<RunAnnouncer />);
		act(() => scenario().startRun("coll_1"));
		act(() => scenario().streamLost("coll_1", "dropped"));
		act(() => scenario().setStreaming("coll_1", false));
		expect(region()).toHaveTextContent("Collection run started");
	});
});
