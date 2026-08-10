/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a capacity-discovery run found: the highest concurrency the target held
 * inside its latency budget, the level it gave out at, and the per-level trail
 * the search left behind.
 *
 * The headline is a sentence rather than a stat grid because the mode exists to
 * answer one question in words - "what can my service take" - and four numbers
 * side by side make the reader assemble that answer themselves. The levels
 * table below it is the evidence, so a reader who distrusts the headline can
 * see the shape of the curve it came from.
 *
 * Silent for every other mode. A fixed-target run measured a point rather than
 * a curve, so an empty shell here would imply it looked for a limit and found
 * none.
 */

import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { RunReport } from "@/types/domain";

/**
 * Why the search stopped, in words, and whether that reading is bad news.
 *
 * `slo_exceeded` is the only stop that observed the target give out - the rest
 * ended on a bound the *caller* set, which is not a fault. Unknown reasons
 * render under their raw key rather than vanishing: a newer sidecar may stop
 * for a reason this build has no words for, and the levels below still say what
 * happened.
 */
const STOP_REASONS: Record<string, { label: string; detail: string; degraded: boolean }> = {
	slo_exceeded: {
		label: "Latency budget exceeded",
		detail: "p99 stayed above the budget across two consecutive windows.",
		degraded: true,
	},
	plateau: {
		label: "Throughput plateaued",
		detail: "More concurrency stopped buying more throughput, while latency still held.",
		degraded: true,
	},
	cap_reached: {
		label: "Reached the concurrency ceiling",
		detail: "The target held its budget all the way up. Raise the ceiling to find the limit.",
		degraded: false,
	},
	deadline: {
		label: "Ran out of time",
		detail: "The run's deadline passed before the search found a limit.",
		degraded: false,
	},
	stopped: {
		label: "Stopped by hand",
		detail: "The run was stopped before the search reached a conclusion.",
		degraded: false,
	},
};

/** Trailing zeros are noise on a latency the search measured to the ms. */
function formatMs(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatRps(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

export interface CapacitySummaryProps {
	capacity: RunReport["capacity"];
	className?: string;
}

export function CapacitySummary({ capacity, className }: CapacitySummaryProps) {
	if (!capacity) return null;

	const stop = STOP_REASONS[capacity.stopReason];
	const sustained = capacity.maxHealthyConcurrency !== undefined;
	// A search can end before its first level closed - `stepDuration` longer
	// than `duration`, or a run stopped seconds after it started - and the
	// engine reports the section anyway, because "judged nothing" is itself the
	// finding that says to lengthen the run or shorten the step. Absent levels
	// and absent `maxHealthy*` are therefore two different states, and only this
	// flag separates them: without it the "no level met the budget" sentence
	// below claims a measurement at the lowest concurrency that was never taken,
	// directly contradicting the "Ran out of time" badge beside it.
	const judgedNothing = capacity.levels.length === 0;

	return (
		<Card className={className}>
			<CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
				<CardTitle className="text-base">Capacity</CardTitle>
				{/*
				 * `Badge variant="chip"`, not a hand-rolled span. The variant is
				 * the one that lets a caller own the colour without inheriting a
				 * `hover:bg-*` it cannot override, and going through the
				 * primitive is also what supplies the radius: a box with no
				 * radius class at all is pinned square for a user who chose the
				 * Rounded setting (app/CLAUDE.md, "No bare `rounded`").
				 *
				 * The colour is a tint plus a `-text` token, never the bare
				 * `--status-*` fill as a foreground - the three-token rule
				 * (docs/design-system.md, "Status tokens").
				 */}
				<Badge
					variant="chip"
					className={cn(
						"font-medium",
						stop?.degraded
							? "bg-warning/10 text-warning-text"
							: "bg-status-success/10 text-status-success-text"
					)}
				>
					{stop?.label ?? capacity.stopReason}
				</Badge>
			</CardHeader>
			<CardContent>
				<p className="text-sm text-foreground">
					{judgedNothing ? (
						<>
							The search ended before it finished measuring a single level, so it has
							nothing to report about this target. Give the run longer than one step,
							or shorten the step.
						</>
					) : sustained ? (
						<>
							Sustained{" "}
							<span className="font-mono font-semibold">
								{capacity.maxHealthyConcurrency}
							</span>{" "}
							concurrent connections at{" "}
							<span className="font-mono font-semibold">
								{formatRps(capacity.maxHealthyRps ?? 0)}
							</span>{" "}
							req/s, with a p99 of{" "}
							<span className="font-mono font-semibold">
								{formatMs(capacity.p99AtMaxHealthyMs ?? 0)}ms
							</span>{" "}
							against a {formatMs(capacity.sloMs)}ms budget.
						</>
					) : (
						<>
							No level met the {formatMs(capacity.sloMs)}ms budget - the target was
							already over it at the lowest concurrency the search tried.
						</>
					)}
				</p>
				{capacity.kneeConcurrency !== undefined && (
					<p className="mt-1.5 text-sm text-muted-foreground">
						It gave out at{" "}
						<span className="font-mono font-medium text-foreground">
							{capacity.kneeConcurrency}
						</span>{" "}
						connections, where p99 reached{" "}
						<span className="font-mono font-medium text-warning-text">
							{formatMs(capacity.kneeP99Ms ?? 0)}ms
						</span>
						.
					</p>
				)}
				{stop && <p className="mt-1.5 text-xs text-muted-foreground">{stop.detail}</p>}

				{capacity.levels.length > 0 && (
					<div className="mt-3 overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-rule text-xs text-muted-foreground">
									<th className="py-1.5 pr-3 text-left font-medium">
										Connections
									</th>
									<th className="py-1.5 pr-3 text-right font-medium">
										Throughput
									</th>
									<th className="py-1.5 text-right font-medium">p99</th>
								</tr>
							</thead>
							<tbody>
								{capacity.levels.map((level, index) => {
									const overBudget = level.p99Ms > capacity.sloMs;
									return (
										// Index, not concurrency: a level the search
										// re-measured after one bad window appears
										// twice, and that repeat is the audit trail
										// doing its job rather than a duplicate key.
										<tr
											key={`${level.concurrency}-${index}`}
											className="border-b border-rule last:border-b-0"
										>
											<td className="py-1.5 pr-3 font-mono">
												{level.concurrency}
											</td>
											<td className="py-1.5 pr-3 text-right font-mono text-muted-foreground">
												{formatRps(level.rps)}
											</td>
											<td
												className={cn(
													"py-1.5 text-right font-mono",
													overBudget
														? "text-warning-text"
														: "text-muted-foreground"
												)}
											>
												{formatMs(level.p99Ms)}ms
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
