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
 * The header's configuration is the `loadTestConfig` the launch site handed
 * the store. It used to be rebuilt as a field list, which dropped any field it
 * was not told about. The file's name and hash (#2051) ride the same config. A
 * finished run's row count and file come from its report, in `LoadTestDetail`
 * (`LoadTestDetail.data-rows.test.tsx`).
 *
 * Mutation check: hand the header a field list that omits `dataRowCount`, or
 * `dataFileName` / `dataFileHash`, in `index.tsx` and the matching case
 * reddens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useDashboardStore } from "@/stores";
import type { DashboardHeaderProps } from "./types";
import LoadTestDashboard from "./index";

const headerProps = vi.hoisted(() => ({ latest: null as unknown }));

vi.mock("./components", () => ({
	DashboardHeader: (props: unknown) => {
		headerProps.latest = props;
		return null;
	},
	MetricsView: () => null,
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
