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
 * The live phase carries the row count to the header (#1940).
 *
 * Before the report loads, the dashboard builds its configuration from the
 * `loadTestConfig` the launch site handed the store; that branch listed its
 * fields one by one and so dropped any it was not told about.
 *
 * The file's name and hash (#2051) ride the same two branches: the launch
 * config while live, the report's configuration once it loads.
 *
 * Mutation check: remove `dataRowCount` from the `loadTestConfig` branch of
 * `displayConfiguration` in `index.tsx` and the live case reddens; remove
 * `dataFileName` / `dataFileHash` there and the live file case reddens. The
 * report case reads the spread of `runConfiguration`, so it reddens if that
 * spread is replaced by a field list that omits them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useDashboardStore } from "@/stores";
import type { RunReport } from "@/types";
import type { DashboardHeaderProps } from "./types";
import LoadTestDashboard from "./index";

const headerProps = vi.hoisted(() => ({ latest: null as unknown }));

vi.mock("./components", () => ({
	DashboardHeader: (props: unknown) => {
		headerProps.latest = props;
		return null;
	},
	MetricsView: () => null,
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

const configuration = () => (headerProps.latest as DashboardHeaderProps).configuration;

beforeEach(() => {
	headerProps.latest = null;
	useDashboardStore.setState({ currentRunId: "run_1", mode: "running", isStreaming: true });
});

describe("the dashboard's live configuration", () => {
	it("passes the launch config's row count to the header", () => {
		useDashboardStore.setState({
			loadTestConfig: { mode: "constant_concurrency", concurrency: 5, dataRowCount: 12 },
		});
		render(<LoadTestDashboard />);

		expect(configuration()?.dataRowCount).toBe(12);
	});

	it("passes none for a run launched without a data file", () => {
		useDashboardStore.setState({
			loadTestConfig: { mode: "constant_concurrency", concurrency: 5 },
		});
		render(<LoadTestDashboard />);

		expect(configuration()?.dataRowCount).toBeUndefined();
	});

	it("passes the launch config's file name and hash to the header", () => {
		const dataFileHash = "a".repeat(64);
		useDashboardStore.setState({
			loadTestConfig: {
				mode: "constant_concurrency",
				concurrency: 5,
				dataRowCount: 2,
				dataFileName: "users.csv",
				dataFileHash,
			},
		});
		render(<LoadTestDashboard />);

		expect(configuration()?.dataFileName).toBe("users.csv");
		expect(configuration()?.dataFileHash).toBe(dataFileHash);
	});

	it("passes no file name for a run launched without a data file", () => {
		useDashboardStore.setState({
			loadTestConfig: { mode: "constant_concurrency", concurrency: 5 },
		});
		render(<LoadTestDashboard />);

		expect(configuration()?.dataFileName).toBeUndefined();
	});
});

describe("the dashboard's report configuration", () => {
	it("takes the file name and hash from the report once it loads", () => {
		const dataFileHash = "b".repeat(64);
		useDashboardStore.setState({
			mode: "completed",
			isStreaming: false,
			// The launch config names a different file, so the report is what
			// the header must be reading.
			loadTestConfig: { mode: "constant_concurrency", dataFileName: "stale.csv" },
			finalReport: {
				metadata: {
					runId: "run_1",
					runType: "load",
					status: "completed",
					startTime: 0,
					endTime: 1000,
					configuration: {
						mode: "constant_concurrency",
						concurrency: 5,
						dataRowCount: 2,
						dataFileName: "users.csv",
						dataFileHash,
					},
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
			} as unknown as RunReport,
		});
		render(<LoadTestDashboard />);

		expect(configuration()?.dataFileName).toBe("users.csv");
		expect(configuration()?.dataFileHash).toBe(dataFileHash);
	});
});
