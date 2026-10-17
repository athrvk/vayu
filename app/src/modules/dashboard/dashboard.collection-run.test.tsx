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
 * What the dashboard hands its header beyond the URL (#2270).
 *
 * A collection load run's target comes from the run's row (the hook is stubbed
 * here, its own test reads the row), and the comment comes from wherever the
 * phase has one: the launch config while live, the stored report once the run
 * has finished - where the header is the only place left to draw it, because
 * `LoadTestDetail` no longer does.
 *
 * Mutation check: stop passing `collectionName` / `stepCount`, or the report
 * phase's `comment`, in `index.tsx` and the matching case reddens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@/test/render-with-tooltips";
import { withQueryClient } from "@/test/query-wrapper";
import { useDashboardStore } from "@/stores";
import type { RunReport } from "@/types";
import type { DashboardHeaderProps } from "./types";
import LoadTestDashboard from "./index";

const headerProps = vi.hoisted(() => ({ latest: null as unknown }));
const target = vi.hoisted(() => ({ value: {} as { collectionName?: string; stepCount?: number } }));

vi.mock("./components", () => ({
	DashboardHeader: (props: unknown) => {
		headerProps.latest = props;
		return null;
	},
	MetricsView: () => null,
}));
vi.mock("./hooks/useCollectionRunTarget", () => ({ useCollectionRunTarget: () => target.value }));
vi.mock("@/modules/history/main/LoadTestDetail", () => ({ default: () => null }));
vi.mock("@/services", () => ({
	apiService: { getRunReport: vi.fn().mockResolvedValue(null) },
	loadTestService: {
		isMonitoring: () => true,
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
	},
}));

const header = () => headerProps.latest as DashboardHeaderProps;

function report(comment: string | undefined): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1,
			configuration: { comment },
		},
		summary: {
			totalRequests: 100,
			successfulRequests: 100,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 100,
		},
		latency: {
			min: 1,
			max: 2,
			avg: 1,
			median: 1,
			p50: 1,
			p75: 1,
			p90: 1,
			p95: 1,
			p99: 2,
			p999: 2,
		},
		statusCodes: { "200": 100 },
		errors: { total: 0, withDetails: 0, types: {} },
	};
}

beforeEach(() => {
	headerProps.latest = null;
	target.value = {};
	useDashboardStore.setState({
		currentRunId: "run_1",
		mode: "running",
		isStreaming: true,
		finalReport: null,
		loadTestConfig: null,
		requestInfo: null,
	});
});

describe("the live header's target and comment", () => {
	it("passes the collection and step count of a collection load run", () => {
		target.value = { collectionName: "Checkout", stepCount: 4 };
		render(withQueryClient(<LoadTestDashboard />));

		expect(header().collectionName).toBe("Checkout");
		expect(header().stepCount).toBe(4);
	});

	it("passes none for a request-level run", () => {
		render(withQueryClient(<LoadTestDashboard />));

		expect(header().collectionName).toBeUndefined();
		expect(header().stepCount).toBeUndefined();
	});

	it("passes the launch config's comment", () => {
		useDashboardStore.setState({
			loadTestConfig: {
				mode: "constant_concurrency",
				concurrency: 5,
				comment: "before the fix",
			},
		});
		render(withQueryClient(<LoadTestDashboard />));

		expect(header().comment).toBe("before the fix");
	});
});

describe("the finished header's comment", () => {
	it("passes the stored report's comment, since the report body no longer draws it", () => {
		useDashboardStore.setState({
			mode: "completed",
			isStreaming: false,
			finalReport: report("before the fix"),
		});
		render(withQueryClient(<LoadTestDashboard />));

		expect(header().comment).toBe("before the fix");
	});

	it("passes none for a run that had none", () => {
		useDashboardStore.setState({
			mode: "completed",
			isStreaming: false,
			finalReport: report(undefined),
		});
		render(withQueryClient(<LoadTestDashboard />));

		expect(header().comment).toBeUndefined();
	});
});
