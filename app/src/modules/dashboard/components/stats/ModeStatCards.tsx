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

import { formatLatency, formatLatencyParts, formatNumber } from "@/lib/format-number";
import { fmt } from "../format";
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
			value={fmt(perVu, 2)}
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
			value={d.elapsedSeconds.toFixed(1)}
			unit="s"
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
			value={eta !== null ? Math.round(eta).toString() : "-"}
			unit={eta !== null ? "s" : undefined}
			infoTip={TOOLTIPS.remainingEta}
		/>
	);
}

/** Mean iter time - average wall-clock per iteration (tracks p50 closely). */
export function MeanIterTimeStat({ d }: { d: DashboardDerived }) {
	const { value, unit } = formatLatencyParts(d.meanLatency);
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
 * uncrossed run says so and names the SLO (from the breakpoint, not the current
 * setting), since "-" reads as "not measured". The SLO goes in the sub-line:
 * "not crossed" alone fills most of a card's value row.
 */
export function BreakpointStat({ d }: { d: DashboardDerived }) {
	const { crossed, concurrency, sloMs } = d.breakpoint;
	const reached = crossed && concurrency !== null;
	// A null SLO means no tick was ever judged (report-only History, run not started):
	// "not crossed" would assert a result nobody measured, so that stays "-".
	const value = reached ? formatNumber(concurrency) : sloMs === null ? "-" : "not crossed";
	return (
		<StatCard
			label="Breakpoint"
			value={value}
			sub={!reached && sloMs ? `SLO ${formatLatency(sloMs)}` : undefined}
			infoTip={TOOLTIPS.breakpoint}
		/>
	);
}

/** p99 at peak - tail latency at the breakpoint (or current p99 if uncrossed). */
export function P99AtPeakStat({ d }: { d: DashboardDerived }) {
	const p99 = d.breakpoint.crossed ? (d.breakpoint.p99Ms ?? d.p99Latency) : d.p99Latency;
	const { value, unit } = formatLatencyParts(p99);
	return <StatCard label="p99 at peak" value={value} unit={unit} infoTip={TOOLTIPS.p99AtPeak} />;
}
