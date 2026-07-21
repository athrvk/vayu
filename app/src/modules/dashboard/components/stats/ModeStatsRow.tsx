/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ModeStatsRow — the mode-adaptive Row 4 router. Four stat cards swap on d.mode.
 * For three of the four modes the 4th card is the universal p99 latency stat;
 * the first three switch per mode (Plan 4 §62–69):
 *
 *   constant_rps         Duration · Total requests · Peak concurrency · p99
 *   constant_concurrency Duration · Total requests · Throughput / VU   · p99
 *   iterations           Elapsed  · Remaining (ETA) · Mean iter time   · p99
 *   ramp_up              Peak concurrency · Breakpoint · p99 at peak · Total requests
 *
 * ramp_up is the lone exception: its 4th stat is Total requests, not p99, so
 * that branch renders all four cards itself. Shared cards (Duration / Total /
 * Peak) and the universal p99 card live here; the mode-only cards live in
 * ModeStatCards.tsx. Consumes {@link DashboardDerived}; never re-derives from
 * raw metrics (gate #9). All InfoChip copy via TOOLTIPS.
 */

import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";
import { fmt } from "../shared";
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

/** First-three (or, for ramp_up, all four) stats per mode + the universal p99. */
function renderModeStats(d: DashboardDerived) {
	switch (d.mode) {
		case "constant_concurrency":
			return (
				<>
					<DurationStat d={d} />
					<TotalRequestsStat d={d} />
					<ThroughputPerVuStat d={d} />
					<P99StatCard d={d} />
				</>
			);
		case "iterations":
			return (
				<>
					<ElapsedStat d={d} />
					<RemainingEtaStat d={d} />
					<MeanIterTimeStat d={d} />
					<P99StatCard d={d} />
				</>
			);
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
					<P99StatCard d={d} />
				</>
			);
	}
}

/** Duration — configured wall-clock with cleanup-overhead sub. */
function DurationStat({ d }: { d: DashboardDerived }) {
	return (
		<StatCard
			label="Duration"
			value={fmt(d.testDuration, 2)}
			unit="s"
			sub={
				<>
					cleanup overhead{" "}
					{d.setupOverhead !== undefined ? (
						<span className="text-muted-foreground">{d.setupOverhead.toFixed(2)}s</span>
					) : (
						<span className="text-subtle-foreground">—</span>
					)}
				</>
			}
			infoTip={TOOLTIPS.duration}
		/>
	);
}

/** Total requests — cumulative count with failed-count sub. */
function TotalRequestsStat({ d }: { d: DashboardDerived }) {
	return (
		<StatCard
			label="Total requests"
			value={formatNumber(d.totalRequests)}
			sub={
				<>
					failed{" "}
					<span
						className={cn(
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

/** Peak concurrency — max in-flight with backpressure sub. */
function PeakConcurrencyStat({ d }: { d: DashboardDerived }) {
	return (
		<StatCard
			label="Peak concurrency"
			value={formatNumber(d.peakConcurrency)}
			sub={
				<>
					backpressure{" "}
					<span className="text-muted-foreground">{formatNumber(d.backpressure)}</span>
				</>
			}
			infoTip={TOOLTIPS.peakConcurrency}
		/>
	);
}

/** The universal 4th stat — p99 latency with mean/median sub-text. */
export function P99StatCard({ d }: { d: DashboardDerived }) {
	return (
		<StatCard
			label="p99 latency"
			value={d.p99Latency.toFixed(0)}
			unit="ms"
			sub={
				d.p99Latency > 0 ? (
					<>
						mean{" "}
						<span className="text-muted-foreground">{d.meanLatency.toFixed(0)} ms</span>
						{d.medianLatency > 0 && (
							<>
								{" · "}median{" "}
								<span className="text-muted-foreground">
									{d.medianLatency.toFixed(0)} ms
								</span>
							</>
						)}
					</>
				) : (
					<span className="text-muted-foreground italic">awaiting samples</span>
				)
			}
			infoTip={TOOLTIPS.p99Latency}
		/>
	);
}
