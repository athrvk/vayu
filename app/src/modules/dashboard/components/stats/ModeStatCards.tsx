/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ModeStatCards - the mode-specific Row 4 stats that exist for only one load
 * mode (constant_concurrency / iterations / ramp_up). The shared cards
 * (Duration, Total requests, Peak virtual users / in-flight requests) and the universal p99 card live
 * in ModeStatsRow.tsx, which routes between these per d.mode. All cards are pure
 * presentational reads off {@link DashboardDerived}; InfoChip copy via TOOLTIPS.
 */

import {
	formatLatency,
	formatLatencyPartsOrDash,
	formatNumber,
	formatSeconds,
} from "@/lib/format-number";
import { fmtRate } from "../format";
import { TOOLTIPS } from "../tooltips";
import type { DashboardDerived } from "../../types";
import { computeEta } from "../../utils/computeEta";
import { StatCard } from "./StatCard";

// ---- constant_concurrency ----

/** Throughput per virtual user - achieved throughput divided by configured concurrency. */
export function ThroughputPerVuStat({ d }: { d: DashboardDerived }) {
	const perVu =
		d.throughput !== undefined && d.configuredConcurrency && d.configuredConcurrency > 0
			? d.throughput / d.configuredConcurrency
			: undefined;
	return (
		<StatCard
			label="Throughput per virtual user"
			value={fmtRate(perVu)}
			unit="req/s"
			infoTip={TOOLTIPS.throughputPerVu}
		/>
	);
}

// ---- iterations ----

/** Elapsed - wall-clock since start (iterations count up to completion). */
export function ElapsedStat({ d }: { d: DashboardDerived }) {
	return (
		<StatCard
			label="Elapsed"
			value={formatSeconds(d.elapsedSeconds)}
			infoTip={TOOLTIPS.duration}
		/>
	);
}

/** Remaining (ETA) - projected seconds to finish the remaining iterations. */
export function RemainingEtaStat({ d }: { d: DashboardDerived }) {
	const eta = computeEta({
		requestsExpected: d.requestsExpected,
		requestsSent: d.requestsSent,
		currentRps: d.currentRps,
	});
	return (
		<StatCard
			label="Remaining (ETA)"
			value={eta !== null ? formatSeconds(eta) : "-"}
			infoTip={TOOLTIPS.remainingEta}
		/>
	);
}

/** Mean iter time - average wall-clock per iteration (tracks p50 closely). */
export function MeanIterTimeStat({ d }: { d: DashboardDerived }) {
	const { value, unit } = formatLatencyPartsOrDash(d.meanLatency);
	return (
		<StatCard
			label="Mean iter time"
			value={value}
			unit={unit}
			infoTip={TOOLTIPS.meanIterTime}
		/>
	);
}

// ---- ramp_up ----

/**
 * Breakpoint - concurrency at which p99 first crossed the SLO threshold. An
 * uncrossed run says so and names the line (from the breakpoint, not the current
 * setting), since "-" reads as "not measured": "SLO" for a run's own, "Settings"
 * for the Settings threshold (#2939). It goes in the sub-line: "not crossed"
 * alone fills most of a card's value row.
 */
export function BreakpointStat({ d }: { d: DashboardDerived }) {
	const { crossed, concurrency, sloMs, sloSource } = d.breakpoint;
	const reached = crossed && concurrency !== null;
	// A null SLO means no tick was ever judged (report-only History, run not started):
	// "not crossed" would assert a result nobody measured, so that stays "-".
	const value = reached ? formatNumber(concurrency) : sloMs === null ? "-" : "not crossed";
	return (
		<StatCard
			label="Breakpoint"
			value={value}
			sub={
				!reached && sloMs
					? `${sloSource === "run" ? "SLO" : "Settings"} ${formatLatency(sloMs)}`
					: undefined
			}
			infoTip={TOOLTIPS.breakpoint}
		/>
	);
}

/**
 * p99 at peak - the worst whole-second p99 while the run held its peak load,
 * not the breakpoint tick's, which was read at a lighter load. The run's p99 so
 * far stands in until a tick at the peak has a reading.
 */
export function P99AtPeakStat({ d }: { d: DashboardDerived }) {
	const p99 = d.p99AtPeakMs ?? d.p99Latency;
	const { value, unit } = formatLatencyPartsOrDash(p99);
	return <StatCard label="p99 at peak" value={value} unit={unit} infoTip={TOOLTIPS.p99AtPeak} />;
}
