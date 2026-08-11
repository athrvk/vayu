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
 * Issue #476: `timingBreakdown` carries two halves that are present
 * independently - averages over the retained trace sample, and `phases`
 * percentiles over every completion.
 *
 * The defect this file guards is the one the split introduced: a renderer that
 * tests `report.timingBreakdown` rather than the half it actually reads. For a
 * run that stored no traces the object now exists with only `phases`, so such a
 * renderer paints five empty average bars and a confident "0 ms" total.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui";
import type { RunReport } from "@/types";
import { PhasePercentiles } from "./PhasePercentiles";
import { TimingWaterfall } from "./TimingWaterfall";

function withTooltips(node: React.ReactNode) {
	return render(<TooltipProvider>{node}</TooltipProvider>);
}

type Breakdown = NonNullable<RunReport["timingBreakdown"]>;

function reportWith(timingBreakdown: Breakdown | undefined): RunReport {
	return {
		summary: {
			totalRequests: 1,
			successfulRequests: 1,
			failedRequests: 0,
			errorRate: 0,
			totalDurationSeconds: 1,
			avgRps: 1,
		},
		latency: { min: 5, max: 5, avg: 5, p50: 5, p90: 5, p95: 5, p99: 5 },
		statusCodes: {},
		errors: { total: 0, withDetails: 0, types: {} },
		timingBreakdown,
	} as RunReport;
}

/** Healthy: every phase's tail sits close to its body. */
const CALM_PHASES: NonNullable<Breakdown["phases"]> = {
	dns: { p50: 2, p95: 3, p99: 4, max: 6, count: 4321 },
	connect: { p50: 5, p95: 6, p99: 8, max: 11, count: 4321 },
	tls: { p50: 12, p95: 14, p99: 18, max: 25, count: 4321 },
	firstByte: { p50: 30, p95: 40, p99: 55, max: 90, count: 4321 },
	download: { p50: 2, p95: 3, p99: 4, max: 7, count: 4321 },
};

describe("PhasePercentiles", () => {
	it("renders a row per phase with its percentiles", () => {
		withTooltips(<PhasePercentiles report={reportWith({ phases: CALM_PHASES })} />);

		for (const label of ["DNS", "Connect", "TLS", "TTFB", "Download"]) {
			expect(screen.getByText(label)).toBeTruthy();
		}
		for (const header of ["p50", "p95", "p99", "max"]) {
			expect(screen.getByText(header)).toBeTruthy();
		}
		// The population is named, so a reader does not read these as the
		// averages card's sample.
		expect(screen.getByText(/4,321/)).toBeTruthy();
	});

	// Absent section = nothing rendered. An empty table would claim the run
	// measured phases and found nothing.
	it("renders nothing when the run recorded no distributions", () => {
		const { container } = withTooltips(
			<PhasePercentiles report={reportWith({ avgDnsMs: 1, avgTlsMs: 2 })} />
		);
		expect(container.textContent).toBe("");
	});

	it("renders nothing without a report at all", () => {
		const { container } = withTooltips(<PhasePercentiles report={null} />);
		expect(container.textContent).toBe("");
	});

	// The reason a percentile view beats an average one. A TLS p50 of 0 with a
	// large p99 is connection churn: most requests reused a connection, a few
	// re-handshaked, and the mean of the two looks merely unremarkable.
	//
	// Mutation check: drop the `p50 === 0` branch from `isTailHeavy` and this
	// case stops being flagged, because `tailRatio` is null for a zero p50.
	it("calls out a phase whose tail towers over its body", () => {
		withTooltips(
			<PhasePercentiles
				report={reportWith({
					phases: {
						...CALM_PHASES,
						tls: { p50: 0, p95: 0, p99: 40, max: 61, count: 4321 },
					},
				})}
			/>
		);
		expect(screen.getByText(/TLS.*p99 far above the p50/s)).toBeTruthy();
	});

	// A phase that is simply fast is not a finding: 0.01ms to 0.4ms is a 40x
	// ratio over four tenths of a millisecond.
	it("does not call out a large ratio over sub-millisecond values", () => {
		withTooltips(
			<PhasePercentiles
				report={reportWith({
					phases: {
						...CALM_PHASES,
						dns: { p50: 0.01, p95: 0.2, p99: 0.4, max: 0.9, count: 4321 },
					},
				})}
			/>
		);
		expect(screen.queryByText(/p99 far above the p50/)).toBeNull();
	});

	it("says nothing when every phase's tail is proportionate", () => {
		withTooltips(<PhasePercentiles report={reportWith({ phases: CALM_PHASES })} />);
		expect(screen.queryByText(/p99 far above the p50/)).toBeNull();
	});
});

describe("TimingWaterfall reads the averages half, not the object", () => {
	// The regression the split would otherwise introduce. A run that stored no
	// traces now has a `timingBreakdown` - with only `phases` in it - and the
	// waterfall renders averages.
	//
	// Mutation check: restore `hasData = !!report?.timingBreakdown` and the
	// total below reads "0 ms" instead of "- ms".
	it("shows the empty state for a phases-only report", () => {
		withTooltips(<TimingWaterfall report={reportWith({ phases: CALM_PHASES })} />);

		expect(screen.getByText("- ms")).toBeTruthy();
		expect(screen.queryByText("0 ms")).toBeNull();
	});

	it("shows the averages when they are there", () => {
		withTooltips(
			<TimingWaterfall
				report={reportWith({
					avgDnsMs: 1,
					avgConnectMs: 2,
					avgTlsMs: 3,
					avgFirstByteMs: 4,
					avgDownloadMs: 5,
					phases: CALM_PHASES,
				})}
			/>
		);
		expect(screen.getByText("15 ms")).toBeTruthy();
	});
});
