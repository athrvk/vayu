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
 * What the dashboard hands its header from the engine's phase (#3568).
 *
 * The engine says when a run is draining its in-flight requests; the dashboard
 * never works it out from elapsed against the configured duration. Both run
 * past the plan in a healthy run that is still sending, so a guess would call
 * a slow run "Finishing".
 *
 * Mutation check: derive `draining` from `elapsedDuration > plannedSeconds * 1000`
 * and the "past the plan, still sending" case reddens; read the phase off
 * anything but the latest frame and the draining case reddens; pass `waitingOn`
 * outside the drain and the sending case reddens.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useDashboardStore } from "@/stores";
import type { LoadTestMetrics } from "@/types";
import LoadTestDashboard from "./index";

const headerProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("./components", () => ({
	DashboardHeader: (props: Record<string, unknown>) => {
		headerProps.push(props);
		return null;
	},
	MetricsView: () => null,
}));
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

const lastHeader = () => headerProps[headerProps.length - 1];

function frame(patch: Partial<LoadTestMetrics>): LoadTestMetrics {
	return {
		timestamp: 1,
		elapsed_seconds: 18,
		requests_completed: 100,
		requests_failed: 0,
		current_rps: 10,
		current_concurrency: 0,
		avg_latency_ms: 5,
		bytes_sent: 0,
		bytes_received: 0,
		live: true,
		...patch,
	};
}

function mountWithFrame(patch: Partial<LoadTestMetrics>) {
	useDashboardStore.getState().addMetricsBatch("run_1", [frame(patch)]);
	return render(<LoadTestDashboard />);
}

beforeEach(() => {
	headerProps.length = 0;
	useDashboardStore.getState().startRun("run_1", { mode: "constant_rps", duration: "15s" });
});

describe("the header's drain props", () => {
	it("passes draining and what the run waits on when the frame says draining", () => {
		mountWithFrame({ phase: "draining", backpressure: 10 });

		expect(lastHeader()).toMatchObject({
			draining: true,
			waitingOn: 10,
			plannedSeconds: 15,
		});
	});

	it("does not call a run draining for being past its plan while the engine says sending", () => {
		mountWithFrame({ phase: "sending", backpressure: 10, elapsed_seconds: 18 });

		expect(lastHeader()).toMatchObject({ draining: false, plannedSeconds: 15 });
		expect(lastHeader().waitingOn).toBeUndefined();
	});

	it("passes no drain for a frame with no phase", () => {
		mountWithFrame({ backpressure: 10 });

		expect(lastHeader()).toMatchObject({ draining: false });
		expect(lastHeader().waitingOn).toBeUndefined();
	});

	it("passes no planned seconds for an open-ended run", () => {
		useDashboardStore.getState().startRun("run_1", { mode: "constant_rps" });
		mountWithFrame({});

		expect(lastHeader().plannedSeconds).toBeUndefined();
	});
});
