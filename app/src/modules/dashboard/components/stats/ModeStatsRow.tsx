/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ModeStatsRow — the mode-adaptive Row 4. Four stat cards swap per mode; the
 * p99 latency stat is universal (always the 4th). Consumes
 * {@link DashboardDerived}; never re-derives from raw metrics.
 *
 * NOTE (Plan 4 fan-out): the per-mode stat sets for constant_concurrency,
 * iterations, and ramp_up are filled in by task A2 (using computeEta /
 * computeBreakpoint from utils). Until then every mode renders the
 * constant_rps set (Duration · Total requests · Peak concurrency · p99),
 * preserving today's behaviour exactly.
 */

import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";
import { fmt } from "../shared";
import { TOOLTIPS } from "../tooltips";
import type { DashboardDerived } from "../../types";
import { StatCard } from "./StatCard";

export function ModeStatsRow({ d }: { d: DashboardDerived }) {
	return (
		<div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
			<StatCard
				label="Duration"
				value={fmt(d.testDuration, 2)}
				unit="s"
				sub={
					<>
						cleanup overhead{" "}
						{d.setupOverhead !== undefined ? (
							<span className="text-muted-foreground">
								{d.setupOverhead.toFixed(2)}s
							</span>
						) : (
							<span className="text-subtle-foreground">—</span>
						)}
					</>
				}
				infoTip={TOOLTIPS.duration}
			/>
			<StatCard
				label="Total requests"
				value={formatNumber(d.totalRequests)}
				sub={
					<>
						failed{" "}
						<span
							className={cn(
								d.failedRequests > 0 ? "text-destructive" : "text-muted-foreground"
							)}
						>
							{formatNumber(d.failedRequests)}
						</span>
					</>
				}
				infoTip={TOOLTIPS.totalRequests}
			/>
			<StatCard
				label="Peak concurrency"
				value={formatNumber(d.peakConcurrency)}
				sub={
					<>
						backpressure{" "}
						<span className="text-muted-foreground">
							{formatNumber(d.backpressure)}
						</span>
					</>
				}
				infoTip={TOOLTIPS.peakConcurrency}
			/>
			<P99StatCard d={d} />
		</div>
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
					<span className="text-subtle-foreground italic">awaiting samples</span>
				)
			}
			infoTip={TOOLTIPS.p99Latency}
		/>
	);
}
