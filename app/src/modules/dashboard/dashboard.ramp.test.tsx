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
 * The ramp fields the live metrics view reads (#1945).
 *
 * The ramp duration was parsed with a seconds-only `parseInt`, so "2m" read as
 * 2. A finished run's ramp comes from its report through `reportToDerived`,
 * which `reportToDerived.test.ts` holds to the same parse (#2220).
 *
 * Mutation check: swap `durationSeconds` for `parseInt` in the `rampConfig`
 * memo and the minutes case reddens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useDashboardStore } from "@/stores";
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
}));

// The collection target is read from the run's row; these cases are about the
// live configuration, not that lookup (`dashboard.collection-run.test.tsx`).
vi.mock("./hooks/useCollectionRunTarget", () => ({ useCollectionRunTarget: () => ({}) }));

vi.mock("@/services", () => ({
	apiService: { getRunReport: vi.fn().mockResolvedValue(null) },
	loadTestService: {
		isMonitoring: () => true,
		startMonitoring: vi.fn(),
		stopMonitoring: vi.fn(),
	},
}));

const rampConfig = () => (metricsProps.latest as { rampConfig: RampConfig }).rampConfig;

beforeEach(() => {
	metricsProps.latest = null;
	useDashboardStore.setState({
		currentRunId: "run_1",
		mode: "running",
		isStreaming: true,
		loadTestConfig: null,
		finalReport: null,
	});
});

describe("the dashboard's ramp configuration", () => {
	it("reads a ramp given in minutes as seconds", () => {
		useDashboardStore.setState({
			loadTestConfig: {
				mode: "ramp_up",
				concurrency: 50,
				startConcurrency: 5,
				rampUpDuration: "2m",
			},
		});
		render(<LoadTestDashboard />);

		expect(rampConfig()).toEqual({
			rampUpDurationSeconds: 120,
			startConcurrency: 5,
			targetConcurrency: 50,
		});
	});

	it("passes no ramp duration for a value that is not a duration", () => {
		useDashboardStore.setState({
			loadTestConfig: { mode: "ramp_up", rampUpDuration: "soon" },
		});
		render(<LoadTestDashboard />);

		expect(rampConfig().rampUpDurationSeconds).toBeUndefined();
	});
});
