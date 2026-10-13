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
 * The ramp fields the metrics view reads come from the report first (#1945).
 *
 * `build_run_report_config` emits `rampUpDuration` and `startConcurrency`, so a
 * loaded report is the source of truth; the launch config only fills what a
 * report lacks. A back-fill spread over the report would replace its values
 * with `undefined` whenever the launch config is gone (a run opened from
 * History), and the ramp duration was parsed with a seconds-only `parseInt`,
 * so "2m" read as 2.
 *
 * Mutation check: put the unconditional `loadTestConfig?.` spread back in
 * `displayConfiguration` and the report-first cases redden; swap
 * `durationSeconds` for `parseInt` in the `rampConfig` prop and the minutes
 * case reddens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useDashboardStore } from "@/stores";
import type { RunReport } from "@/types";
import LoadTestDashboard from "./index";

interface RampConfig {
	rampUpDurationSeconds?: number;
	startConcurrency?: number;
	targetConcurrency?: number;
}

const metricsProps = vi.hoisted(() => ({ latest: null as unknown }));

vi.mock("./components", () => ({
	DashboardHeader: () => null,
	MetricsView: (props: unknown) => {
		metricsProps.latest = props;
		return null;
	},
	RequestResponseView: () => null,
}));

vi.mock("@/services", () => ({
	apiService: { getRunReport: vi.fn().mockResolvedValue(null) },
	loadTestService: {
		isMonitoring: () => true,
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
	},
}));

const rampConfig = () => (metricsProps.latest as { rampConfig: RampConfig }).rampConfig;

function reportWith(configuration: Record<string, unknown>): RunReport {
	return {
		metadata: {
			runId: "run_1",
			runType: "load",
			status: "completed",
			startTime: 0,
			endTime: 1000,
			configuration,
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
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
	} as unknown as RunReport;
}

beforeEach(() => {
	metricsProps.latest = null;
	useDashboardStore.setState({
		currentRunId: "run_1",
		mode: "completed",
		isStreaming: false,
		loadTestConfig: null,
		finalReport: null,
	});
});

describe("the dashboard's ramp configuration", () => {
	it("reads the ramp from the report when no launch config remains", () => {
		useDashboardStore.setState({
			finalReport: reportWith({
				mode: "ramp_up",
				concurrency: 50,
				startConcurrency: 5,
				rampUpDuration: "2m",
			}),
		});
		render(<LoadTestDashboard />);

		expect(rampConfig()).toEqual({
			rampUpDurationSeconds: 120,
			startConcurrency: 5,
			targetConcurrency: 50,
		});
	});

	it("prefers the report's ramp over the launch config's", () => {
		useDashboardStore.setState({
			loadTestConfig: { mode: "ramp_up", rampUpDuration: "30s", startConcurrency: 1 },
			finalReport: reportWith({
				mode: "ramp_up",
				concurrency: 50,
				startConcurrency: 5,
				rampUpDuration: "60s",
			}),
		});
		render(<LoadTestDashboard />);

		expect(rampConfig().rampUpDurationSeconds).toBe(60);
		expect(rampConfig().startConcurrency).toBe(5);
	});

	it("fills a report that lacks the ramp from the launch config", () => {
		useDashboardStore.setState({
			loadTestConfig: { mode: "ramp_up", rampUpDuration: "30s", startConcurrency: 1 },
			finalReport: reportWith({ mode: "ramp_up", concurrency: 50 }),
		});
		render(<LoadTestDashboard />);

		expect(rampConfig().rampUpDurationSeconds).toBe(30);
		expect(rampConfig().startConcurrency).toBe(1);
	});

	it("passes no ramp duration for a value that is not a duration", () => {
		useDashboardStore.setState({
			finalReport: reportWith({ mode: "ramp_up", rampUpDuration: "soon" }),
		});
		render(<LoadTestDashboard />);

		expect(rampConfig().rampUpDurationSeconds).toBeUndefined();
	});
});
