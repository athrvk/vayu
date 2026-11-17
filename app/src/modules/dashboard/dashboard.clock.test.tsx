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
 * The header's clock reads the plan only while the run is live (#3568).
 *
 * A live run past its configured duration reads `00:18 / 00:15`. A run that is
 * no longer live (the report fetch gave up, so the live view stays) has no
 * plan left to count toward and reads `00:15 elapsed`, the same as a run
 * configured with no duration.
 *
 * Mutation check: pass `plannedSeconds` to the header whether or not the run is
 * live and the not-live case reddens (`00:15 / 00:15`).
 */

import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import { useDashboardStore } from "@/stores";
import type { LoadTestMetrics } from "@/types";
import LoadTestDashboard from "./index";

vi.mock("./components/MetricsView", () => ({ default: () => null }));
vi.mock("./hooks/useCollectionRunTarget", () => ({ useCollectionRunTarget: () => ({}) }));
vi.mock("@/services", () => ({
	apiService: { getRunReport: vi.fn().mockResolvedValue(null) },
	loadTestService: {
		isMonitoring: () => true,
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
		settleOnStoredReport: vi.fn(),
	},
}));

function frame(elapsedSeconds: number): LoadTestMetrics {
	return {
		timestamp: 1,
		elapsed_seconds: elapsedSeconds,
		requests_completed: 100,
		requests_failed: 0,
		current_rps: 10,
		current_concurrency: 0,
		avg_latency_ms: 5,
		bytes_sent: 0,
		bytes_received: 0,
		live: true,
	};
}

function startRun(elapsedSeconds: number) {
	const store = useDashboardStore.getState();
	store.startRun("run_1", { mode: "constant_rps", duration: "15s" });
	store.addMetricsBatch("run_1", [frame(elapsedSeconds)]);
}

describe("the header clock", () => {
	it("reads elapsed over the plan while the run is live", () => {
		startRun(18);
		render(<LoadTestDashboard />);

		expect(screen.getByText(/00:18 \/ 00:15/)).toBeInTheDocument();
	});

	it("reads elapsed alone once the run is not live, though a duration is configured", () => {
		startRun(15);
		useDashboardStore.setState({
			phase: { phase: "reportError", message: "no report", stopped: false },
		});
		render(<LoadTestDashboard />);

		expect(screen.getByText(/00:15 elapsed/)).toBeInTheDocument();
		expect(screen.queryByText(/ \/ /)).toBeNull();
	});
});
