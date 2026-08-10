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
 * A scenario load run's report (issue #357).
 *
 * The run is `type: "load"` - it publishes ticks and reports percentiles like
 * any load run - so it lands in this pane rather than in `ScenarioRunView`. What
 * it does *not* have is a single method and URL, or per-step `results` rows: the
 * per-step breakdown in the summary is the only place it says what each step
 * did. Both halves are asserted here, because the failure mode of getting either
 * wrong is a pane that renders confidently and says nothing true.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import type { ReactElement } from "react";
import LoadTestDetail from "./LoadTestDetail";
import type { RunReport, RunScenarioStepStat } from "@/types";

vi.mock("@/queries/runs", () => ({
	useRunTimeSeriesQuery: () => ({
		data: undefined,
		isLoading: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
		hasNextPage: false,
	}),
}));

function renderReport(ui: ReactElement) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>{ui}</TooltipProvider>
		</QueryClientProvider>
	);
}

const STEPS: RunScenarioStepStat[] = [
	{
		index: 0,
		name: "Log in",
		requestId: "req_a",
		method: "POST",
		executed: 40,
		errors: 0,
		latency: { min: 1, p50: 4, p95: 9, p99: 12, max: 30 },
	},
	{
		index: 1,
		name: "List orders",
		requestId: "req_b",
		method: "GET",
		executed: 34,
		errors: 6,
		latency: { min: 2, p50: 15, p95: 40, p99: 90, max: 120 },
	},
];

function report(scenario?: RunReport["scenario"]): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			...(scenario ? {} : { requestUrl: "https://api.test/ping", requestMethod: "GET" }),
		},
		summary: {
			totalRequests: 74,
			failedRequests: 6,
			requestsPerSecond: 10,
			testDuration: 7.4,
		},
		latency: { min: 1, max: 120, avg: 10, p50: 8, p95: 30, p99: 90 },
		...(scenario ? { scenario } : {}),
	} as unknown as RunReport;
}

const SCENARIO: RunReport["scenario"] = {
	iterations: 40,
	iterationsCompleted: 34,
	stepsExecuted: 74,
	passed: 68,
	failed: 0,
	skipped: 0,
	errored: 6,
	stepsStored: 0,
	stepsDropped: 0,
	virtualUsers: 8,
	iterationsAbandoned: 6,
	steps: STEPS,
};

describe("a scenario load run", () => {
	it("says what the sequence was instead of inventing a method and URL", () => {
		renderReport(<LoadTestDetail report={report(SCENARIO)} runId="run_1" />);

		expect(screen.getByText("SEQUENCE")).toBeTruthy();
		expect(screen.getByText(/2 steps per iteration - 8 virtual users/)).toBeTruthy();
		// The pane's fallback for a missing URL is the string "Unknown URL"; a
		// scenario has no URL by construction, so showing it would be a lie the
		// user cannot distinguish from a broken run.
		expect(screen.queryByText(/unknown url/i)).toBeNull();
	});

	it("offers a Steps tab, and it is the breakdown that gets rendered there", () => {
		renderReport(<LoadTestDetail report={report(SCENARIO)} runId="run_1" />);

		const tab = screen.getByRole("tab", { name: /steps/i });
		// Radix switches tabs on mousedown, not on a synthesised click.
		fireEvent.mouseDown(tab);

		// What the table says is `ScenarioStepsTab`'s own test; what matters here
		// is that the tab exists and is wired to the report's breakdown rather
		// than to the sampled-requests list beside it.
		expect(screen.getByText("Log in")).toBeTruthy();
		expect(screen.getByText("List orders")).toBeTruthy();
	});
});

describe("a single-request load run", () => {
	it("keeps its method and URL and grows no Steps tab", () => {
		renderReport(<LoadTestDetail report={report()} runId="run_1" />);

		expect(screen.getByText("https://api.test/ping")).toBeTruthy();
		expect(screen.queryByText("SEQUENCE")).toBeNull();
		// An empty tab is worse than no tab: it invites a click that answers
		// nothing.
		expect(screen.queryByRole("tab", { name: /steps/i })).toBeNull();
	});

	it("grows no Steps tab for a report whose scenario section carries no steps", () => {
		// A design-mode collection run's report has a `scenario` object with no
		// breakdown - it reports its steps as `results[]` rows instead - and this
		// pane must not claim it has one.
		const designMode = { ...SCENARIO, virtualUsers: undefined, steps: undefined };
		renderReport(<LoadTestDetail report={report(designMode)} runId="run_1" />);

		expect(screen.queryByRole("tab", { name: /steps/i })).toBeNull();
		expect(screen.queryByText("SEQUENCE")).toBeNull();
	});
});
