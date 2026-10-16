/**
 * @vitest-environment jsdom
 */
/**
 * Characterization snapshots for the hero cards. Lock exact SVG/DOM output
 * BEFORE the B6 HeroCardShell extraction; the refactor must keep every snapshot
 * byte-identical (catches chrome drift, spacing changes, dropped bars/chips).
 */

import { afterAll, describe, it, expect, vi } from "vitest";

// The formatters build their Intl.NumberFormat at module load, so the locale is
// pinned before the imports below run rather than left to the host.
const restoreIntl = vi.hoisted(() => {
	const Real = Intl.NumberFormat;
	class EnUsNumberFormat extends Real {
		constructor(_locale?: string | string[], options?: Intl.NumberFormatOptions) {
			super("en-US", options);
		}
	}
	Intl.NumberFormat = EnUsNumberFormat as typeof Intl.NumberFormat;
	return () => {
		Intl.NumberFormat = Real;
	};
});

afterAll(restoreIntl);

import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { RateFidelityCard } from "./RateFidelityCard";
import { ThroughputTwinCard } from "./ThroughputTwinCard";
import { ErrorRateCard } from "./ErrorRateCard";
import { DroppedRequestsCard } from "./DroppedRequestsCard";
import { AchievedThroughputCard } from "./AchievedThroughputCard";
import { ConcurrencyUtilCard } from "./ConcurrencyUtilCard";
import { ProgressCard } from "./ProgressCard";
import { ThroughputCard } from "./ThroughputCard";
import { CurrentConcurrencyCard } from "./CurrentConcurrencyCard";
import { SaturationCard } from "./SaturationCard";
import { LatencyPercentilesCard } from "./LatencyPercentilesCard";
import { HeroRow } from "./HeroRow";
import type { DashboardDerived } from "../../types";
import type { Breakpoint } from "../../utils/computeBreakpoint";

const crossed: Breakpoint = { crossed: true, concurrency: 45, timeSeconds: 6, p99Ms: 227 };
const notCrossed: Breakpoint = {
	crossed: false,
	concurrency: null,
	timeSeconds: null,
	p99Ms: null,
};

const snap = (ui: React.ReactElement) => {
	// Components here use `InfoChip`, which no longer brings its own
	// `TooltipProvider` - the delay is set once at the app root (main.tsx).
	const { container } = render(<TooltipProvider>{ui}</TooltipProvider>);
	expect(container.innerHTML).toMatchSnapshot();
};

describe("hero cards (characterization)", () => {
	it("RateFidelityCard", () => snap(<RateFidelityCard targetRps={100} actualRps={96} />));
	it("ThroughputTwinCard (no queue chip)", () =>
		snap(<ThroughputTwinCard sendRate={96} throughput={96} avgQueueWaitMs={0} />));
	it("ThroughputTwinCard (queue chip)", () =>
		snap(<ThroughputTwinCard sendRate={120} throughput={80} avgQueueWaitMs={12} />));
	it("ErrorRateCard", () =>
		snap(
			<ErrorRateCard
				totalRequests={600}
				failedRequests={5}
				httpErrors={3}
				noResponse={2}
				statusCodes={{ "200": 595, "404": 2, "500": 1, "0": 2 }}
			/>
		));
	it("DroppedRequestsCard", () => snap(<DroppedRequestsCard dropped={120} completed={880} />));
	it("AchievedThroughputCard", () =>
		snap(<AchievedThroughputCard throughput={3940} configuredConcurrency={50} />));
	it("ConcurrencyUtilCard", () =>
		snap(<ConcurrencyUtilCard currentConcurrency={47} configuredConcurrency={50} />));
	it("ProgressCard", () =>
		snap(<ProgressCard requestsSent={1500} requestsExpected={4000} currentRps={500} />));
	it("ThroughputCard", () => snap(<ThroughputCard throughput={1284} meanLatency={204} />));
	it("CurrentConcurrencyCard", () =>
		snap(
			<CurrentConcurrencyCard
				currentConcurrency={897}
				targetConcurrency={50}
				rampUpDurationSeconds={8}
				rampDeviationPct={1066}
			/>
		));
	it("SaturationCard (degrading)", () =>
		snap(<SaturationCard breakpoint={crossed} failedRequests={0} />));
	it("SaturationCard (healthy)", () =>
		snap(<SaturationCard breakpoint={notCrossed} failedRequests={0} />));
	it("LatencyPercentilesCard", () =>
		snap(<LatencyPercentilesCard p95={240} p99={1234} meanLatency={101} medianLatency={98} />));
	it("LatencyPercentilesCard (awaiting samples)", () =>
		snap(<LatencyPercentilesCard p95={0} p99={0} meanLatency={0} medianLatency={0} />));
});

describe("hero throughput reads grouped (Intl), a missing one reads '-'", () => {
	const text = (ui: React.ReactElement) =>
		render(<TooltipProvider>{ui}</TooltipProvider>).container.textContent;

	it("ThroughputCard", () => {
		expect(text(<ThroughputCard throughput={3940} meanLatency={204} />)).toContain("3,940");
	});
	it("AchievedThroughputCard, per-user rate included", () => {
		const out = text(<AchievedThroughputCard throughput={3940} configuredConcurrency={2} />);
		expect(out).toContain("3,940");
		expect(out).toContain("1,970");
	});
	it("ThroughputTwinCard, dispatched and received", () => {
		const out = text(
			<ThroughputTwinCard sendRate={4500} throughput={3940} avgQueueWaitMs={0} />
		);
		expect(out).toContain("4,500");
		expect(out).toContain("3,940");
		expect(out).toContain("Δ 560");
	});
	it.each([
		["ThroughputCard", <ThroughputCard meanLatency={204} />],
		["AchievedThroughputCard", <AchievedThroughputCard />],
		["ThroughputTwinCard", <ThroughputTwinCard />],
	])("%s draws '-', not a measured 0, without a value", (_name, ui) => {
		const out = text(ui);
		expect(out).toContain("-");
		expect(out).not.toMatch(/(^|[^\d.])0 ?req\/s/);
	});
});

function derived(mode: DashboardDerived["mode"]): DashboardDerived {
	return {
		mode,
		isCompleted: false,
		targetRps: 100,
		actualRps: 100,
		sendRate: 100,
		throughput: 3940,
		currentRps: 100,
		avgQueueWaitMs: 0,
		totalRequests: 1000,
		failedRequests: 0,
		httpErrors: 0,
		noResponse: 0,
		statusCodes: {},
		requestsExpected: 1000,
		requestsSent: 500,
		peakConcurrency: 20,
		currentConcurrency: 20,
		configuredConcurrency: 20,
		backpressure: 0,
		p99Latency: 1234,
		meanLatency: 20,
		medianLatency: 18,
		p95Latency: 456,
		testDuration: 30,
		elapsedSeconds: 10,
		droppedRequests: 0,
		showDropped: false,
		breakpoint: { crossed: false, concurrency: null, timeSeconds: null, p99Ms: null },
	};
}

describe("HeroRow latency card", () => {
	const renderRow = (mode: DashboardDerived["mode"]) =>
		render(
			<TooltipProvider>
				<HeroRow d={derived(mode)} />
			</TooltipProvider>
		).container.textContent ?? "";

	it.each(["constant_rps", "constant_concurrency", "iterations"] as const)(
		"%s leads with throughput and shows p95 and p99 beside it",
		(mode) => {
			const out = renderRow(mode);
			expect(out).toContain("3,940");
			expect(out).toContain("p95");
			expect(out).toContain("456");
			expect(out).toContain("p99");
			expect(out).toContain("1,234");
		}
	);

	it.each(["ramp_up", "capacity"] as const)(
		"%s keeps its p99 in the stats row, so the hero has no latency card",
		(mode) => {
			renderRow(mode);
			expect(screen.queryByText("p95")).toBeNull();
			expect(screen.queryByText("p99")).toBeNull();
		}
	);
});
