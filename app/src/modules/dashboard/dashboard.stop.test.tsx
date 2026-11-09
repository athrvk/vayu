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
 * What the dashboard does with the engine's answer to Stop (#3367).
 *
 * The engine answers `stopped` (the Stop took effect), `completed` / `failed`
 * (the run had already finished) or `running` (the strategy returned on its
 * own and the run ends by its own verdict). Only the first is the user's Stop
 * ending the run; the others must leave the run to settle with the engine's
 * status, as History and the report show it.
 *
 * Mutation check: call `stopMonitoring` / `stopRun` for every answer again and
 * the completed, failed and running cases redden; drop the callout from
 * `index.tsx` and the note cases redden. The store's own settle-as-the-report
 * rule is held in `dashboard-store.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { withQueryClient } from "@/test/query-wrapper";
import { useDashboardStore, useToastStore } from "@/stores";
import type { RunReport } from "@/types";
import { apiService, loadTestService } from "@/services";
import LoadTestDashboard from "./index";

const headerProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("./components", () => ({
	DashboardHeader: (props: Record<string, unknown>) => {
		headerProps.push(props);
		return null;
	},
	MetricsView: () => <div data-testid="live-metrics" />,
}));

vi.mock("@/services", () => ({
	apiService: { getRunReport: vi.fn(), stopRun: vi.fn() },
	loadTestService: {
		isMonitoring: () => true,
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		settleOnStoredReport: vi.fn(),
	},
}));

const LATE_NOTE = "The run had already finished when Stop arrived.";

function reportFor(status: "completed" | "failed" | "stopped"): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status,
			startTime: 0,
			endTime: 1000,
			requestUrl: "https://api.test/ping",
			requestMethod: "GET",
		},
		summary: {
			totalRequests: 10,
			successfulRequests: 10,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 10,
		},
		latency: { min: 1, max: 2, avg: 1, p50: 1, p90: 1, p95: 1, p99: 2 },
		statusCodes: { "200": 10 },
		errors: { total: 0, withDetails: 0, types: {} },
	};
}

const lastHeader = () => headerProps[headerProps.length - 1];
const store = () => useDashboardStore.getState();

function renderStreamingRun() {
	store().startRun("run_1");
	return render(withQueryClient(<LoadTestDashboard />));
}

/** Press Stop the way the header's button does, and let the answer land. */
async function pressStop(): Promise<void> {
	const onStop = lastHeader().onStop as () => Promise<void>;
	await act(() => onStop());
}

function answerStopWith(status: string): void {
	vi.mocked(apiService.stopRun).mockResolvedValue({ runId: "run_1", status });
}

beforeEach(() => {
	headerProps.length = 0;
	vi.mocked(apiService.getRunReport)
		.mockReset()
		.mockResolvedValue(null as never);
	vi.mocked(apiService.stopRun).mockReset();
	vi.mocked(loadTestService.stopMonitoring).mockClear();
	useToastStore.setState({ toasts: [] });
});

describe("Stop answered stopped", () => {
	it("releases the stream and awaits the report as stopped", async () => {
		answerStopWith("stopped");
		renderStreamingRun();

		await pressStop();

		expect(loadTestService.stopMonitoring).toHaveBeenCalledTimes(1);
		expect(store().phase).toEqual({ phase: "awaitingReport", stopped: true });
		expect(store().stopArrivedLate).toBe(false);
		expect(lastHeader()).toMatchObject({ live: false, endedAs: "stopped" });
	});
});

describe.each(["completed", "failed"] as const)("Stop answered %s", (status) => {
	beforeEach(() => answerStopWith(status));

	it("leaves the stream to settle the run and does not announce a stop", async () => {
		renderStreamingRun();

		await pressStop();

		expect(loadTestService.stopMonitoring).not.toHaveBeenCalled();
		expect(store().phase).toEqual({ phase: "streaming" });
		expect(store().stopArrivedLate).toBe(true);
		expect(lastHeader()).toMatchObject({ live: true, endedAs: null });
	});

	it("settles as the engine's status, with the late-Stop note beside the report", async () => {
		renderStreamingRun();
		await pressStop();

		act(() => store().setFinalReport("run_1", reportFor(status)));

		expect(store().phase).toMatchObject({ phase: "finished", kind: status });
		expect(lastHeader()).toMatchObject({ live: false, endedAs: status });
		expect(await screen.findByText(LATE_NOTE)).toBeInTheDocument();
	});
});

describe("Stop answered running", () => {
	it("changes nothing: the run keeps streaming and ends by its own verdict", async () => {
		answerStopWith("running");
		renderStreamingRun();

		await pressStop();

		expect(loadTestService.stopMonitoring).not.toHaveBeenCalled();
		expect(store().phase).toEqual({ phase: "streaming" });
		expect(store().stopArrivedLate).toBe(false);
		expect(lastHeader()).toMatchObject({ live: true, endedAs: null });

		act(() => store().setFinalReport("run_1", reportFor("completed")));

		expect(store().phase).toMatchObject({ phase: "finished", kind: "completed" });
		expect(screen.queryByText(LATE_NOTE)).toBeNull();
	});
});

describe("Stop that cannot reach the engine", () => {
	it("toasts the failure and leaves the run as it was", async () => {
		vi.mocked(apiService.stopRun).mockRejectedValue(new Error("Engine unreachable"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		renderStreamingRun();

		await pressStop();

		await waitFor(() =>
			expect(useToastStore.getState().toasts).toEqual([
				expect.objectContaining({
					message: "Couldn't stop the run - Engine unreachable",
					variant: "error",
				}),
			])
		);
		expect(loadTestService.stopMonitoring).not.toHaveBeenCalled();
		expect(store().phase).toEqual({ phase: "streaming" });
		expect(store().stopArrivedLate).toBe(false);
	});
});

describe("a run that finished without a late Stop", () => {
	it("shows the report with no note", () => {
		renderStreamingRun();

		act(() => store().setFinalReport("run_1", reportFor("completed")));

		expect(store().phase).toMatchObject({ phase: "finished" });
		expect(screen.queryByText(LATE_NOTE)).toBeNull();
	});
});
