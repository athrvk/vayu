/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ModeStatsRow - the mode-adaptive Row 4 router. The stat cards swap on d.mode.
 * This table is the authority for which cards a mode shows - add a mode here,
 * beside the branch that renders it:
 *
 *   constant_rps         Duration · Total requests · Peak in-flight requests
 *   constant_concurrency Duration · Total requests · Throughput per virtual user
 *   iterations           Elapsed  · Remaining (ETA) · Mean iter time
 *   ramp_up              Peak virtual users · Breakpoint · p99 at peak · Total requests
 *   capacity             Peak virtual users · Breakpoint · p99 at peak · Total requests
 *
 * The three throughput-led modes show three cards: their p99 sits in the hero
 * row's latency card (`LatencyPercentilesCard`, beside p95, over the run so
 * far), so it is not drawn twice. ramp_up and capacity keep p99 here, as p99 at peak. Shared cards
 * (Duration / Total / Peak) live here; the mode-only cards live in
 * ModeStatCards.tsx. Consumes {@link DashboardDerived}; never re-derives from
 * raw metrics. All InfoChip copy via TOOLTIPS.
 */

import { cn } from "@/lib/utils";
import { CONCURRENCY_UNIT, isClosedLoopMode } from "@/constants/load-test-modes";
import { formatNumber, formatSeconds } from "@/lib/format-number";
import { orDash } from "../format";
import { TOOLTIPS } from "../tooltips";
import type { DashboardDerived } from "../../types";
import { StatCard } from "./StatCard";
import {
	BreakpointStat,
	ElapsedStat,
	MeanIterTimeStat,
	P99AtPeakStat,
	RemainingEtaStat,
	ThroughputPerVuStat,
} from "./ModeStatCards";

export function ModeStatsRow({ d }: { d: DashboardDerived }) {
	return (
		<div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
			{renderModeStats(d)}
		</div>
	);
}

/** The stat cards for each mode. */
function renderModeStats(d: DashboardDerived) {
	switch (d.mode) {
		case "constant_concurrency":
			return (
				<>
					<DurationStat d={d} />
					<TotalRequestsStat d={d} />
					<ThroughputPerVuStat d={d} />
				</>
			);
		case "iterations":
			return (
				<>
					<ElapsedStat d={d} />
					<RemainingEtaStat d={d} />
					<MeanIterTimeStat d={d} />
				</>
			);
		// Capacity discovery asks the same four questions `ramp_up` does - how
		// high did it get, where did it break, how slow was it there - which is
		// the whole of what the mode exists to answer.
		case "capacity":
		case "ramp_up":
			return (
				<>
					<PeakConcurrencyStat d={d} />
					<BreakpointStat d={d} />
					<P99AtPeakStat d={d} />
					<TotalRequestsStat d={d} />
				</>
			);
		case "constant_rps":
		default:
			return (
				<>
					<DurationStat d={d} />
					<TotalRequestsStat d={d} />
					<PeakConcurrencyStat d={d} />
				</>
			);
	}
}

/** Duration - configured wall-clock with cleanup-overhead sub. */
function DurationStat({ d }: { d: DashboardDerived }) {
	return (
		<StatCard
			label="Duration"
			value={orDash(d.testDuration, formatSeconds)}
			sub={
				<>
					cleanup overhead{" "}
					{d.setupOverhead !== undefined ? (
						<span className="text-muted-foreground">
							{formatSeconds(d.setupOverhead)}
						</span>
					) : (
						<span className="text-subtle-foreground">-</span>
					)}
				</>
			}
			infoTip={TOOLTIPS.duration}
		/>
	);
}

/** Total requests - cumulative count with error-count sub. */
function TotalRequestsStat({ d }: { d: DashboardDerived }) {
	return (
		<StatCard
			label="Total requests"
			value={formatNumber(d.totalRequests)}
			sub={
				<>
					errors{" "}
					<span
						className={cn(
							"transition-colors duration-150",
							d.failedRequests > 0 ? "text-destructive-text" : "text-muted-foreground"
						)}
					>
						{formatNumber(d.failedRequests)}
					</span>
				</>
			}
			infoTip={TOOLTIPS.totalRequests}
		/>
	);
}

/**
 * Peak concurrency - max in-flight with backpressure sub. Virtual users in a
 * closed-loop mode, requests in flight under Constant RPS: the same measurement,
 * named for what the mode lets it count.
 */
function PeakConcurrencyStat({ d }: { d: DashboardDerived }) {
	const closedLoop = isClosedLoopMode(d.mode);
	return (
		<StatCard
			label={closedLoop ? `Peak ${CONCURRENCY_UNIT}` : "Peak in-flight requests"}
			value={formatNumber(d.peakConcurrency)}
			sub={
				<>
					backpressure{" "}
					<span className="text-muted-foreground">{formatNumber(d.backpressure)}</span>
				</>
			}
			infoTip={closedLoop ? TOOLTIPS.peakVirtualUsers : TOOLTIPS.peakInFlight}
		/>
	);
}
