/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a capacity-discovery run found: the most virtual users the target held
 * inside its latency budget and error limit, the level it gave out at, and the
 * per-level trail the search left behind.
 *
 * The headline is a sentence rather than a stat grid because the mode exists to
 * answer one question in words - "what can my service take" - and four numbers
 * side by side make the reader assemble that answer themselves. The levels
 * table below it is the evidence, so a reader who distrusts the headline can
 * see the shape of the curve it came from.
 *
 * The sentence follows why the search stopped, because the same
 * `maxHealthy*` figures mean different things under each reason: a measured
 * capacity when the target gave out (latency or errors), a floor when the
 * search ran out of ceiling, time or patience, and an overshoot when throughput
 * plateaued (the last level tried, not where the curve flattened - the
 * `saturation*` figures name that one). Reading all of them as "Sustained N"
 * claims a limit the search never found.
 *
 * Silent for every other mode. A fixed-target run measured a point rather than
 * a curve, so an empty shell here would imply it looked for a limit and found
 * none.
 */

import type { ReactNode } from "react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatLatency, formatNumber, formatPercent, formatRate } from "@/lib/format-number";
import { CONCURRENCY_LABEL, concurrencyUnit } from "@/constants/load-test-modes";
import type { RunReport } from "@/types/domain";
import { STOP_REASONS, type CapacityResult } from "./capacityStop";

type Capacity = CapacityResult;

/** The engine's limit when the report carries it, the generic wording for a run stored without. */
function stopDetail(capacity: Capacity, fallback: string): string {
	if (capacity.stopReason !== "errors_exceeded" || capacity.maxErrorPct === undefined) {
		return fallback;
	}
	return `More than ${formatNumber(capacity.maxErrorPct)}% of requests failed across two consecutive windows.`;
}

/**
 * The reading at the knee: the error share when errors ended the search, the p99
 * otherwise. Each is printed only when the engine sent it, so an absent figure
 * never renders as "0ms" or "0.0%".
 */
function KneeEvidence({ capacity }: { capacity: Capacity }) {
	if (capacity.stopReason === "errors_exceeded" && capacity.kneeErrorPct !== undefined) {
		return (
			<>
				, where{" "}
				<span className="font-mono font-medium text-warning-text">
					{formatPercent(capacity.kneeErrorPct)}%
				</span>{" "}
				of requests failed
			</>
		);
	}
	if (capacity.kneeP99Ms === undefined) return null;
	return (
		<>
			, where p99 reached{" "}
			<span className="font-mono font-medium text-warning-text">
				{formatLatency(capacity.kneeP99Ms)}
			</span>
		</>
	);
}

/** A search that ran out of ceiling, time or patience: its best level is a floor, not a limit. */
const OPEN_ENDED_STOPS: ReadonlySet<string> = new Set(["cap_reached", "deadline", "stopped"]);

/** The stops with no report field naming the level that was open when they hit. */
const INTERRUPTED_STOPS: ReadonlySet<string> = new Set(["deadline", "stopped"]);

type HeadlineKind =
	"judgedNothing" | "plateau" | "openEnded" | "sustained" | "noLevelOnErrors" | "noLevelOnBudget";

// A search can end before its first level closed - `stepDuration` longer than
// `duration`, or a run stopped seconds after it started - and the engine
// reports the section anyway, because "judged nothing" is itself the finding
// that says to lengthen the run or shorten the step. Absent levels and absent
// `maxHealthy*` are therefore two different states, and only the empty-levels
// check separates them: without it the "no level met the budget" sentence
// claims a measurement at the lowest level that was never taken, directly
// contradicting the "Ran out of time" badge beside it.
function headlineKind(capacity: Capacity): HeadlineKind {
	if (capacity.levels.length === 0) return "judgedNothing";
	// Ahead of the held-level checks: a plateau's `maxHealthy*` is the last level
	// tried, which is not what the headline may print.
	if (capacity.stopReason === "plateau") return "plateau";
	if (capacity.maxHealthyConcurrency === undefined) {
		return capacity.stopReason === "errors_exceeded" ? "noLevelOnErrors" : "noLevelOnBudget";
	}
	return OPEN_ENDED_STOPS.has(capacity.stopReason) ? "openEnded" : "sustained";
}

function Figure({ children }: { children: ReactNode }) {
	return <span className="font-mono font-semibold">{children}</span>;
}

/** Where throughput stopped growing; a plateau stored before `saturation*` existed names no level. */
function PlateauHeadline({ capacity }: { capacity: Capacity }) {
	const { saturationConcurrency, saturationRps, saturationP99Ms } = capacity;
	if (
		saturationConcurrency === undefined ||
		saturationRps === undefined ||
		saturationP99Ms === undefined
	) {
		return <>Throughput stopped growing. More only queued.</>;
	}
	return (
		<>
			Throughput stopped growing at <Figure>{saturationConcurrency}</Figure>{" "}
			{concurrencyUnit(saturationConcurrency)} (<Figure>{formatRate(saturationRps)}</Figure>{" "}
			req/s, p99 <Figure>{formatLatency(saturationP99Ms)}</Figure>). More only queued.
		</>
	);
}

/** A floor: the target held this much and the search stopped for a reason of its own. */
function OpenEndedHeadline({ capacity }: { capacity: Capacity }) {
	const held = capacity.maxHealthyConcurrency ?? 0;
	return (
		<>
			At least <Figure>{held}</Figure> {concurrencyUnit(held)} held the budget (
			<Figure>{formatRate(capacity.maxHealthyRps ?? 0)}</Figure> req/s, p99{" "}
			<Figure>{formatLatency(capacity.p99AtMaxHealthyMs ?? 0)}</Figure>). The search did not
			find a limit.
			{INTERRUPTED_STOPS.has(capacity.stopReason) &&
				" The next level was still being measured."}
		</>
	);
}

function SustainedHeadline({ capacity }: { capacity: Capacity }) {
	const held = capacity.maxHealthyConcurrency ?? 0;
	return (
		<>
			Sustained <Figure>{held}</Figure> {concurrencyUnit(held)} at{" "}
			<Figure>{formatRate(capacity.maxHealthyRps ?? 0)}</Figure> req/s, with a p99 of{" "}
			<Figure>{formatLatency(capacity.p99AtMaxHealthyMs ?? 0)}</Figure> against a{" "}
			{formatLatency(capacity.sloMs)} budget.
		</>
	);
}

function Headline({ capacity }: { capacity: Capacity }) {
	switch (headlineKind(capacity)) {
		case "judgedNothing":
			return (
				<>
					The search ended before it finished measuring a single level, so it has nothing
					to report about this target. Give the run longer than one step, or shorten the
					step.
				</>
			);
		case "plateau":
			return <PlateauHeadline capacity={capacity} />;
		case "openEnded":
			return <OpenEndedHeadline capacity={capacity} />;
		case "sustained":
			return <SustainedHeadline capacity={capacity} />;
		case "noLevelOnErrors":
			return (
				<>
					No level stayed under the error limit - the target was already over it at the
					fewest virtual users the search tried.
				</>
			);
		case "noLevelOnBudget":
			return (
				<>
					No level met the {formatLatency(capacity.sloMs)} budget - the target was already
					over it at the fewest virtual users the search tried.
				</>
			);
	}
}

/**
 * Where the limit sits. With a held level beside it the knee is half of a
 * bracket, not a point: the target held one level and gave out at the next, so
 * the limit lies between them. Without a held level the first one tried already
 * gave out, and the knee is all there is to say.
 */
function KneeSentence({ capacity, knee }: { capacity: Capacity; knee: number }) {
	const held = capacity.maxHealthyConcurrency;
	if (held === undefined) {
		return (
			<>
				It gave out at <span className="font-mono font-medium text-foreground">{knee}</span>{" "}
				{concurrencyUnit(knee)}
				<KneeEvidence capacity={capacity} />.
			</>
		);
	}
	return (
		<>
			The limit lies between{" "}
			<span className="font-mono font-medium text-foreground">{held}</span> and{" "}
			<span className="font-mono font-medium text-foreground">{knee}</span>{" "}
			{concurrencyUnit(knee)}: it held{" "}
			<span className="font-mono font-medium text-foreground">{held}</span> and gave out at{" "}
			<span className="font-mono font-medium text-foreground">{knee}</span>
			<KneeEvidence capacity={capacity} />.
		</>
	);
}

/** True for each level whose concurrency an earlier level already measured. */
function repeatedLevels(levels: Capacity["levels"]): boolean[] {
	const seen = new Set<number>();
	return levels.map(({ concurrency }) => {
		const repeated = seen.has(concurrency);
		seen.add(concurrency);
		return repeated;
	});
}

type OptionalColumn = "p99" | "errors" | "samples";

/** The rightmost column shown: it sits flush, every other one leaves a gutter. */
function lastColumn(showErrors: boolean, showSamples: boolean): OptionalColumn {
	if (showSamples) return "samples";
	return showErrors ? "errors" : "p99";
}

export interface CapacitySummaryProps {
	capacity: RunReport["capacity"];
	className?: string;
}

export function CapacitySummary({ capacity, className }: CapacitySummaryProps) {
	if (!capacity) return null;

	const stop = STOP_REASONS[capacity.stopReason];
	// A run stored before errors were judged has no `errorPct` on any level; its
	// column would be empty cells, so the table keeps its three columns for it.
	const showErrors = capacity.levels.some((level) => level.errorPct !== undefined);
	// Likewise `samples`, absent on a run stored before the engine reported it.
	const showSamples = capacity.levels.some((level) => level.samples !== undefined);
	const repeated = repeatedLevels(capacity.levels);
	const last = lastColumn(showErrors, showSamples);
	const gutter = (column: OptionalColumn) => (column === last ? undefined : "pr-3");

	return (
		<Card className={className}>
			<CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
				<CardTitle>Capacity</CardTitle>
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
						stop && stop.finding !== "none"
							? "bg-warning/10 text-warning-text"
							: "bg-status-success/10 text-status-success-text"
					)}
				>
					{stop?.label ?? capacity.stopReason}
				</Badge>
			</CardHeader>
			<CardContent>
				<p className="text-sm text-foreground">
					<Headline capacity={capacity} />
				</p>
				{capacity.kneeConcurrency !== undefined && (
					<p className="mt-1.5 text-sm text-muted-foreground">
						<KneeSentence capacity={capacity} knee={capacity.kneeConcurrency} />
					</p>
				)}
				{stop && (
					<p className="mt-1.5 text-xs text-muted-foreground">
						{stopDetail(capacity, stop.detail)}
					</p>
				)}

				{capacity.levels.length > 0 && (
					<div className="mt-3 overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-rule text-xs text-muted-foreground">
									<th className="py-1.5 pr-3 text-left font-medium">
										{CONCURRENCY_LABEL}
									</th>
									<th className="py-1.5 pr-3 text-right font-medium">
										Throughput
									</th>
									<th
										className={cn(
											"py-1.5 text-right font-medium",
											gutter("p99")
										)}
									>
										p99
									</th>
									{showErrors && (
										<th
											className={cn(
												"py-1.5 text-right font-medium",
												gutter("errors")
											)}
										>
											Errors
										</th>
									)}
									{showSamples && (
										<th className="py-1.5 text-right font-medium">Samples</th>
									)}
								</tr>
							</thead>
							<tbody>
								{capacity.levels.map((level, index) => {
									const overBudget = level.p99Ms > capacity.sloMs;
									const overErrorLimit =
										level.errorPct !== undefined &&
										capacity.maxErrorPct !== undefined &&
										level.errorPct > capacity.maxErrorPct;
									return (
										// Index, not concurrency: a level the search
										// re-measured after one bad window appears
										// twice, and that repeat is the audit trail
										// doing its job rather than a duplicate key. The label marks the
										// second and later occurrences, so a repeat reads as a re-measure.
										<tr
											key={`${level.concurrency}-${index}`}
											className="border-b border-rule last:border-b-0"
										>
											<td className="py-1.5 pr-3 font-mono">
												{level.concurrency}
												{repeated[index] && (
													<>
														{" "}
														<span className="font-sans text-xs text-muted-foreground">
															re-measured
														</span>
													</>
												)}
											</td>
											<td className="py-1.5 pr-3 text-right font-mono text-muted-foreground">
												{formatRate(level.rps)}
											</td>
											<td
												className={cn(
													"py-1.5 text-right font-mono",
													gutter("p99"),
													overBudget
														? "text-warning-text"
														: "text-muted-foreground"
												)}
											>
												{formatLatency(level.p99Ms)}
											</td>
											{showErrors && (
												<td
													className={cn(
														"py-1.5 text-right font-mono",
														gutter("errors"),
														overErrorLimit
															? "text-warning-text"
															: "text-muted-foreground"
													)}
												>
													{level.errorPct === undefined
														? ""
														: `${formatPercent(level.errorPct)}%`}
												</td>
											)}
											{showSamples && (
												<td className="py-1.5 text-right font-mono text-muted-foreground">
													{level.samples === undefined
														? ""
														: formatNumber(level.samples)}
												</td>
											)}
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
