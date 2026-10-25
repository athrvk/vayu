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
import type { CapacityResult } from "@/components/shared/capacityStop";
import type { DashboardDerived } from "../../types";
import type { Breakpoint } from "../../utils/computeBreakpoint";

const crossed: Breakpoint = {
	crossed: true,
	concurrency: 45,
	timeSeconds: 6,
	p99Ms: 227,
	sloMs: 200,
	atRunStart: false,
};
const notCrossed: Breakpoint = {
	crossed: false,
	concurrency: null,
	timeSeconds: null,
	p99Ms: null,
	sloMs: 200,
	atRunStart: false,
};

const snap = (ui: React.ReactElement) => {
	// Components here use `InfoChip`, which no longer brings its own
	// `TooltipProvider` - the delay is set once at the app root (main.tsx).
	const { container } = render(<TooltipProvider>{ui}</TooltipProvider>);
	expect(container.innerHTML).toMatchSnapshot();
};

describe("hero cards (characterization)", () => {
	it("RateFidelityCard", () =>
		snap(<RateFidelityCard targetRps={100} actualRps={96} achievement={96} />));
	it("ThroughputTwinCard (no queue chip)", () =>
		snap(
			<ThroughputTwinCard
				sendRate={96}
				throughput={96}
				status="kept-pace"
				avgQueueWaitMs={0}
			/>
		));
	it("ThroughputTwinCard (queue chip)", () =>
		snap(
			<ThroughputTwinCard
				sendRate={120}
				throughput={80}
				status="lagging"
				avgQueueWaitMs={12}
			/>
		));
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
	it("DroppedRequestsCard (skipped only)", () =>
		snap(<DroppedRequestsCard dropped={0} completed={880} skipped={120} stalledMs={2400} />));
	it("DroppedRequestsCard (dropped and skipped)", () =>
		snap(<DroppedRequestsCard dropped={40} completed={880} skipped={80} stalledMs={1600} />));
	it("AchievedThroughputCard", () =>
		snap(<AchievedThroughputCard throughput={3940} configuredConcurrency={50} />));
	it("ConcurrencyUtilCard", () =>
		snap(<ConcurrencyUtilCard currentConcurrency={47} configuredConcurrency={50} />));
	it("ConcurrencyUtilCard (mean on the wire)", () =>
		snap(
			<ConcurrencyUtilCard
				currentConcurrency={10}
				configuredConcurrency={10}
				meanInFlight={4.2}
			/>
		));
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
			<ThroughputTwinCard
				sendRate={4500}
				throughput={3940}
				status="lagging"
				avgQueueWaitMs={0}
			/>
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
		rateAchievementPct: 100,
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
		skippedRequests: 0,
		stalledMs: 0,
		showDropped: false,
		breakpoint: {
			crossed: false,
			concurrency: null,
			timeSeconds: null,
			p99Ms: null,
			sloMs: 200,
			atRunStart: false,
		},
	};
}

describe("HeroRow rate fidelity on a stopped run (#2805)", () => {
	it("hands the plan share to the Rate fidelity card", () => {
		const d: DashboardDerived = {
			...derived("constant_rps"),
			stoppedAt: { planSharePct: 50, plannedSeconds: 60 },
		};
		render(
			<TooltipProvider>
				<HeroRow d={d} />
			</TooltipProvider>
		);

		expect(screen.getByText("stopped at 50% of the planned 60s")).toBeInTheDocument();
	});
});

describe("HeroRow Send / Throughput pair on a finished run (#2882)", () => {
	const renderRow = (over: Partial<DashboardDerived>) =>
		render(
			<TooltipProvider>
				<HeroRow d={{ ...derived("constant_rps"), isCompleted: true, ...over }} />
			</TooltipProvider>
		);

	it("prints the sending-window received rate, not the whole-run throughput beside it", () => {
		renderRow({ receivedRate: 98, receivedWindow: "sending" });

		expect(screen.getByText("received while sending")).toBeInTheDocument();
		expect(screen.getByText("98")).toBeInTheDocument();
	});

	it("keeps the plain caption on a derived with no received window", () => {
		renderRow({});

		expect(screen.getByText("received")).toBeInTheDocument();
		expect(screen.getByText("3,940")).toBeInTheDocument();
	});
});

describe("HeroRow queue chip is judged against the run's median latency (#2801)", () => {
	const renderRow = (over: Partial<DashboardDerived>) =>
		render(
			<TooltipProvider>
				<HeroRow d={{ ...derived("constant_rps"), ...over }} />
			</TooltipProvider>
		);

	it("shows 4.8 ms of queue on a 300 ms median", () => {
		renderRow({ avgQueueWaitMs: 4.8, medianLatency: 300 });

		expect(screen.getByText(/^queue/)).toBeInTheDocument();
	});

	// Over the 0.5 ms floor, so only the median keeps it hidden.
	it("hides 2 ms of queue on a 300 ms median", () => {
		renderRow({ avgQueueWaitMs: 2, medianLatency: 300 });

		expect(screen.queryByText(/^queue/)).toBeNull();
	});
});

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
			expect(out).toContain("1.23");
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

describe("a finished ramp_up run's concurrency card (#2870)", () => {
	const renderRamp = (over: Partial<DashboardDerived>) =>
		render(
			<TooltipProvider>
				<HeroRow d={{ ...derived("ramp_up"), ...over }} />
			</TooltipProvider>
		).container.textContent ?? "";

	it("is titled for the peak, with no 'active' unit and no lag dash", () => {
		const out = renderRamp({
			isCompleted: true,
			peakConcurrency: 30,
			currentConcurrency: 0,
			targetConcurrency: 30,
			rampUpDurationSeconds: 30,
		});
		expect(out).toContain("Peak virtual users");
		expect(out).toContain("30");
		expect(out).toContain("targeting 30 over");
		expect(out).not.toContain("Active virtual users");
		expect(out).not.toContain("active");
		expect(out).not.toContain("lag");
		expect(out).not.toContain("ramp ·");
	});

	it("keeps the lag when the stored series supplied one", () => {
		const out = renderRamp({
			isCompleted: true,
			targetConcurrency: 30,
			rampUpDurationSeconds: 30,
			rampDeviationPct: 4.25,
		});
		expect(out).toContain("Peak virtual users");
		expect(out).toContain("ramp · lag 4.3%");
	});

	it("leaves a live run reading Active virtual users with its lag dash", () => {
		const out = renderRamp({ isCompleted: false });
		expect(out).toContain("Active virtual users");
		expect(out).toContain("active");
		expect(out).not.toContain("Peak virtual users");
		expect(out).toContain("lag -%");
	});
});

describe("ConcurrencyUtilCard carries no verdict colour (#2245)", () => {
	// Idle virtual users are a fact about the run's shape, not a failure; the
	// card's own tooltip says as much. The tier is read off the rendered style
	// because it arrives as an inline colour, not a class.
	const STATUS_TOKEN = /--(success|warning|destructive)/;

	it.each([40, 79, 90, 100])("paints utilisation of %i percent with no status colour", (pct) => {
		const { container } = render(
			<TooltipProvider>
				<ConcurrencyUtilCard currentConcurrency={pct} configuredConcurrency={100} />
			</TooltipProvider>
		);

		// Non-empty: a card that rendered nothing would pass the absence check.
		expect(container.textContent).toContain(`${pct}.0% utilisation`);
		expect(container.innerHTML).not.toMatch(STATUS_TOKEN);
		expect(container.innerHTML).not.toMatch(/text-(success|warning|destructive)/);
	});

	it("keeps the number neutral and the bar at its length", () => {
		const { container } = render(
			<TooltipProvider>
				<ConcurrencyUtilCard currentConcurrency={40} configuredConcurrency={100} />
			</TooltipProvider>
		);

		expect(screen.getByText("40", { selector: "span.text-hero" }).className).toContain(
			"text-foreground"
		);
		expect(container.querySelector<HTMLElement>("[style*='width: 40%']")).not.toBeNull();
	});
});

describe("ConcurrencyUtilCard reads the mean on the wire, not the instant (#2821)", () => {
	const text = (ui: React.ReactElement) =>
		render(<TooltipProvider>{ui}</TooltipProvider>).container.textContent;

	it("shows 4.2 of 10 on the wire and 42.0% utilisation for virtual users that wait in step", () => {
		// The instant reads 10 (or 0) for users that never stopped; the mean is the truth.
		const out = text(
			<ConcurrencyUtilCard
				currentConcurrency={10}
				configuredConcurrency={10}
				meanInFlight={4.2}
			/>
		);
		expect(out).toContain("4.2of 10 on the wire");
		expect(out).toContain("42.0% utilisation");
		expect(out).not.toContain("active");
	});

	it("never reads above the configured users when a slow target's completions land in one window", () => {
		const out = text(
			<ConcurrencyUtilCard
				currentConcurrency={0}
				configuredConcurrency={10}
				meanInFlight={20}
			/>
		);
		expect(out).toContain("10.0of 10 on the wire");
		expect(out).toContain("100.0% utilisation");
	});

	it("keeps a measured idle window as 0.0, not the instant", () => {
		const out = text(
			<ConcurrencyUtilCard
				currentConcurrency={10}
				configuredConcurrency={10}
				meanInFlight={0}
			/>
		);
		expect(out).toContain("0.0of 10 on the wire");
		expect(out).toContain("0.0% utilisation");
	});

	it("draws the instant as active users when no mean is supplied", () => {
		const out = text(<ConcurrencyUtilCard currentConcurrency={7} configuredConcurrency={10} />);
		expect(out).toContain("7of 10 active");
		expect(out).toContain("70.0% utilisation");
	});

	it("carries no verdict colour, as the instant card does (#2245)", () => {
		const { container } = render(
			<TooltipProvider>
				<ConcurrencyUtilCard
					currentConcurrency={10}
					configuredConcurrency={10}
					meanInFlight={4.2}
				/>
			</TooltipProvider>
		);
		expect(container.textContent).toContain("42.0% utilisation");
		expect(container.innerHTML).not.toMatch(/--(success|warning|destructive)/);
		expect(container.innerHTML).not.toMatch(/text-(success|warning|destructive)/);
		expect(container.querySelector<HTMLElement>("[style*='width: 42.']")).not.toBeNull();
	});
});

describe("HeroRow utilisation card per mode and run state (#2821)", () => {
	const cardText = (d: DashboardDerived) =>
		render(
			<TooltipProvider>
				<HeroRow d={d} />
			</TooltipProvider>
		).container.textContent ?? "";

	const wave = (over: Partial<DashboardDerived>): DashboardDerived => ({
		...derived("constant_concurrency"),
		currentConcurrency: 10,
		peakConcurrency: 10,
		configuredConcurrency: 10,
		...over,
	});

	it("shows a live run's windowed mean, not the aliasing instant", () => {
		const out = cardText(wave({ currentConcurrency: 0, avgInFlight: 4.2 }));
		expect(out).toContain("4.2of 10 on the wire");
		expect(out).toContain("42.0% utilisation");
	});

	it("shows a finished run's mean, not the peak that makes History read 100%", () => {
		const out = cardText(wave({ isCompleted: true, avgInFlight: 4.2 }));
		expect(out).toContain("4.2of 10 on the wire");
		expect(out).toContain("42.0% utilisation");
		expect(out).not.toContain("100.0% utilisation");
	});

	it("falls back to the peak for a finished run stored before the mean existed", () => {
		const out = cardText(wave({ isCompleted: true, avgInFlight: undefined }));
		expect(out).toContain("10of 10 active");
	});

	it("falls back to the instant for a live frame without the mean", () => {
		const out = cardText(wave({ currentConcurrency: 6, avgInFlight: undefined }));
		expect(out).toContain("6of 10 active");
	});

	it("leaves capacity's card on the instant, whatever the mean says", () => {
		const out = cardText({
			...wave({ currentConcurrency: 6, avgInFlight: 4.2 }),
			mode: "capacity",
		});
		expect(out).toContain("6of 10 active");
		expect(out).not.toContain("on the wire");
	});

	it("leaves ramp_up's card on the instant", () => {
		const out = cardText({
			...wave({ currentConcurrency: 6, avgInFlight: 4.2 }),
			mode: "ramp_up",
		});
		expect(out).toContain("6active");
		expect(out).not.toContain("on the wire");
	});
});

describe("hero cards print counts, percents and spans through the shared formatters (#2318)", () => {
	const text = (ui: React.ReactElement) =>
		render(<TooltipProvider>{ui}</TooltipProvider>).container.textContent;

	it("groups a four-digit virtual-user count", () => {
		expect(
			text(<ConcurrencyUtilCard currentConcurrency={5000} configuredConcurrency={10000} />)
		).toContain("of 10,000 active");
		expect(
			text(<AchievedThroughputCard throughput={8000} configuredConcurrency={10000} />)
		).toContain("from 10,000 virtual users");
	});

	it("groups the headline virtual-user count too", () => {
		expect(text(<CurrentConcurrencyCard currentConcurrency={10000} />)).toContain(
			"10,000active"
		);
		expect(
			text(<ConcurrencyUtilCard currentConcurrency={9400} configuredConcurrency={10000} />)
		).toContain("9,400of 10,000 active");
	});

	it("draws a dash, not a measured zero, for a ramp the run did not declare", () => {
		const out = text(<CurrentConcurrencyCard currentConcurrency={3} />);
		expect(out).toContain("targeting - over - ramp");
		expect(out).toContain("lag -%");
	});

	it("reads a ramp span and a lag through formatSeconds and formatPercent", () => {
		expect(
			text(
				<CurrentConcurrencyCard
					currentConcurrency={3}
					targetConcurrency={50}
					rampUpDurationSeconds={90}
					rampDeviationPct={4.25}
				/>
			)
		).toContain("targeting 50 over 90s ramp · lag 4.3%");
	});

	it("reads a saturation p99 the way the chart does, in seconds from a second up", () => {
		const slow = { ...crossed, p99Ms: 1234 };
		expect(text(<SaturationCard breakpoint={slow} failedRequests={0} />)).toContain(
			"p99 crossed 1.23s (the 200ms SLO) at 45"
		);
	});

	it("names the SLO a crossed saturation card refers to, formatted like the p99 and the chart marker", () => {
		const out = text(
			<SaturationCard breakpoint={{ ...crossed, sloMs: 2000 }} failedRequests={0} />
		);
		expect(out).toContain("p99 crossed 227ms (the 2.00s SLO) at 45 virtual users");
	});

	it("keeps the unnamed line when the breakpoint carries no SLO", () => {
		const out = text(
			<SaturationCard breakpoint={{ ...crossed, sloMs: null }} failedRequests={0} />
		);
		expect(out).toContain("p99 crossed 227ms at 45 virtual users");
		expect(out).not.toContain("SLO");
	});
});

describe("the Saturation card of a capacity run reads the search's stop reason (#2816)", () => {
	const row = (over: Partial<DashboardDerived>) => ({ ...derived("capacity"), ...over });
	const render_ = (d: DashboardDerived) =>
		render(
			<TooltipProvider>
				<HeroRow d={d} />
			</TooltipProvider>
		);
	/** The card's own text, with the eyebrow's label and the sibling cards cut away. */
	const saturation = (d: DashboardDerived): string => {
		const { container } = render_(d);
		const card = [...container.querySelectorAll('[data-slot="card"]')].find((c) =>
			c.textContent?.startsWith("Saturation")
		);
		return card?.textContent ?? "";
	};
	const headline = (text: string) => screen.getByText(text);

	const search = (over: Partial<CapacityResult>): CapacityResult => ({
		sloMs: 200,
		stopReason: "slo_exceeded",
		levels: [],
		...over,
	});

	it("reads a latency stop as degrading, at the level the target gave out", () => {
		const out = saturation(
			row({
				isCompleted: true,
				capacity: search({
					kneeConcurrency: 41,
					kneeP99Ms: 230,
					maxHealthyConcurrency: 31,
				}),
			})
		);
		expect(out).toContain("⚠ degrading");
		expect(out).toContain("p99 crossed 230ms (the 200ms SLO) at 41 virtual users");
		expect(headline("⚠ degrading").className).toContain("text-warning-text");
	});

	it("reads an error stop as degrading, with the share that failed", () => {
		const out = saturation(
			row({
				isCompleted: true,
				failedRequests: 480,
				capacity: search({
					stopReason: "errors_exceeded",
					kneeConcurrency: 30,
					kneeErrorPct: 12.5,
					maxHealthyConcurrency: 20,
				}),
			})
		);
		expect(out).toContain("⚠ degrading");
		expect(out).toContain("12.5% of requests failed at 30 virtual users");
		// The stop reason already says what failed; the count line would repeat it.
		expect(out).not.toContain("480");
	});

	it("reads a plateau as saturated, at the level the engine names", () => {
		const out = saturation(
			row({
				isCompleted: true,
				capacity: search({
					stopReason: "plateau",
					saturationConcurrency: 64,
					saturationRps: 1200,
					saturationP99Ms: 90,
					maxHealthyConcurrency: 96,
				}),
			})
		);
		expect(out).toContain("⚠ saturated");
		expect(out).toContain("Throughput stopped growing at 64 virtual users (1,200 req/s)");
		expect(headline("⚠ saturated").className).toContain("text-warning-text");
	});

	it("names no level for a plateau stored before the engine reported one", () => {
		const out = saturation(
			row({ isCompleted: true, capacity: search({ stopReason: "plateau" }) })
		);
		expect(out).toContain("⚠ saturated");
		expect(out).toContain("Throughput stopped growing");
		expect(out).not.toContain(" at ");
	});

	it.each([
		["cap_reached", "Reached the virtual user ceiling"],
		["deadline", "Ran out of time"],
		["stopped", "Stopped by hand"],
	])("reads %s as no limit found, in a neutral colour", (stopReason, label) => {
		const out = saturation(row({ isCompleted: true, capacity: search({ stopReason }) }));
		expect(out).toContain("no limit found");
		expect(out).toContain(label);
		const cls = headline("no limit found").className;
		expect(cls).toContain("text-foreground");
		expect(cls).not.toMatch(/text-(success|warning|destructive)/);
	});

	it("says searching, never healthy, while the run is live", () => {
		const out = saturation(row({}));
		expect(out).toContain("searching");
		expect(out).not.toContain("healthy");
		expect(headline("searching").className).toContain("text-foreground");
	});

	it("keeps reading the ticks against the run's SLO while it searches", () => {
		const out = saturation(
			row({
				breakpoint: {
					crossed: true,
					concurrency: 22,
					timeSeconds: 12,
					p99Ms: 310,
					sloMs: 250,
					atRunStart: false,
				},
			})
		);
		expect(out).toContain("searching");
		expect(out).toContain("p99 crossed 310ms (the 250ms SLO) at 22 virtual users");
	});

	// S7: the first level already broke the budget, so the search has a knee at
	// level 1 and nothing held - and the ticks may never have crossed the line.
	it("never reads healthy when no level met the budget", () => {
		const out = saturation(
			row({
				isCompleted: true,
				capacity: search({
					kneeConcurrency: 1,
					kneeP99Ms: 350,
					levels: [{ concurrency: 1, rps: 12, p99Ms: 350 }],
				}),
			})
		);
		expect(out).toContain("⚠ degrading");
		expect(out).toContain("p99 crossed 350ms (the 200ms SLO) at 1 virtual user");
		expect(out).not.toContain("healthy");
	});

	it("names errors that did not end the search, without lighting the card", () => {
		const out = saturation(
			row({
				isCompleted: true,
				failedRequests: 3,
				capacity: search({ stopReason: "cap_reached" }),
			})
		);
		expect(out).toContain("no limit found");
		expect(out).toContain("3 errors");
		expect(out).not.toContain("so far");
		expect(headline("no limit found").className).not.toContain("text-warning-text");
	});

	it("counts a single error in the singular, and a live one as so far", () => {
		const out = saturation(row({ failedRequests: 1 }));
		expect(out).toContain("searching");
		expect(out).toContain("1 error so far");
		expect(out).not.toContain("errors");
	});

	it("claims neither a limit nor its absence for a report without the section", () => {
		const out = saturation(row({ isCompleted: true }));
		expect(out).toContain("no result");
		expect(out).not.toMatch(/healthy|searching|no limit found/);
	});

	it("prints a reason this build has no words for under its raw key", () => {
		const out = saturation(
			row({ isCompleted: true, capacity: search({ stopReason: "memory_exceeded" }) })
		);
		expect(out).toContain("no result");
		expect(out).toContain("memory_exceeded");
	});

	it.each([
		"slo_exceeded",
		"errors_exceeded",
		"plateau",
		"cap_reached",
		"deadline",
		"stopped",
		"something_new",
	])("never prints healthy for %s", (stopReason) => {
		const out = saturation(row({ isCompleted: true, capacity: search({ stopReason }) }));
		expect(out).not.toContain("healthy");
	});

	it("leaves ramp_up's card on healthy / degrading", () => {
		expect(saturation(derived("ramp_up"))).toContain("✓ healthy");
	});
});
