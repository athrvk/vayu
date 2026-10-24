/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The run's verdict against the pass/fail budgets it declared.
 *
 * The aggregate half of the report's judgement: a test script asserts one
 * response at a time and structurally cannot say whether the run's p99 or its
 * error rate met a budget, so a run where every assertion passed can still have
 * missed the thing it was run to check.
 *
 * The history detail's Overview shows it, which is also the dashboard's view of
 * a finished run (#2220). Silent when the run declared no budgets: an absent section says
 * "not judged", which is a different claim from "judged and passed nothing" and
 * is the reason a run without budgets renders exactly as it did before.
 *
 * A single check can itself be unmeasurable (issue #1484): a latency ceiling
 * checked against zero completed requests has no number to compare, and
 * showing "0ms" there would read as a real - and passing - measurement.
 */

import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { thresholdReference } from "@/lib/agent-reference";
import { formatNumber } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { formatDuration, pluralize } from "@/modules/dashboard/utils/format";
import type { AssertionPopulation, RunReport } from "@/types/domain";
import { CopyForAgentButton } from "./CopyForAgentButton";
import type { StoppedRun } from "./stopped-run";
import { THRESHOLD_METRICS } from "./threshold-metrics";

/** Trailing zeros are noise on a budget the user typed as a whole number. */
function formatValue(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Prose-sized: "3s", "1m", never "1m 0s". */
function formatSpan(seconds: number): string {
	return formatDuration(seconds * 1000, { omitZeroUnit: true });
}

/**
 * The verdict's pass/fail counts are the engine's and stay as they are; this
 * only says how much of the plan they were judged over. The planned span is
 * dropped once the run reached it (a stop in the last instant), where "of a
 * planned" would describe a shortfall that did not happen.
 */
function stoppedNote({ elapsedSeconds, plannedSeconds }: StoppedRun): string {
	const judged = "Judged on what was measured up to that point.";
	if (elapsedSeconds === undefined) return `Run stopped early. ${judged}`;
	const after = `Run stopped after ${formatSpan(elapsedSeconds)}`;
	if (plannedSeconds === undefined || elapsedSeconds >= plannedSeconds)
		return `${after}. ${judged}`;
	return `${after} of a planned ${formatSpan(plannedSeconds)}. ${judged}`;
}

type Check = NonNullable<RunReport["thresholdValidation"]>["checks"][number];

function populationPhrase({ passed, failed }: AssertionPopulation, scope: string): string {
	const total = passed + failed;
	return `${formatNumber(total)} ${pluralize(total, "assertion")} ${scope} (${formatNumber(failed)} failed)`;
}

/**
 * `sampleRate` is a keep-1-in-N period; absent only if a sidecar omitted it. The
 * wording names the period, not a share of the responses: the engine's reservoir
 * cap can leave the replayed set sparser than 1 in N on a long run.
 */
function sampledScope(sampleRate: number | undefined): string {
	if (sampleRate === undefined) return "on sampled responses";
	if (sampleRate === 1) return "on every response";
	return `on responses sampled at 1 in ${formatNumber(sampleRate)}`;
}

/**
 * Which population the assertion budget's verdict came from (#2892): it judges
 * the worse of the exact inline tally and the sampled `pm.test` replay, and a
 * rate over the blended count would hide a sampled test failing every time.
 * Silent unless the sampled population ran, so a report from before the split
 * and a run with no test script read as they always did.
 */
function assertionPopulationsNote(check: Check): string | null {
	const { assertionsExact: exact, assertionsSampled: sampled, sampleRate } = check;
	// An unmeasurable row reads "no samples"; a population line beside it would contradict that.
	if (check.evaluated === false) return null;
	if (!sampled || sampled.passed + sampled.failed === 0) return null;
	const sampledPhrase = populationPhrase(sampled, sampledScope(sampleRate));
	if (!exact || exact.passed + exact.failed === 0) return `Judged on ${sampledPhrase}.`;
	return `Judged on the worse of ${populationPhrase(exact, "on every response")} and ${sampledPhrase}.`;
}

export interface ThresholdVerdictProps {
	verdict: RunReport["thresholdValidation"];
	/**
	 * Present for a run that was stopped (`stoppedRunOf`): the card then says the
	 * verdict covers only what ran. Absent for every other run.
	 */
	stopped?: StoppedRun;
	/** The run that was judged; each check's "Copy for agent" is absent without it. */
	runId?: string;
	/**
	 * The `thresholds` keys the run's client sent as carried over rather than set
	 * for it (issue #2195), from `metadata.configuration.carriedBudgets`. A check
	 * whose metric is listed is tagged; a listed key with no check is ignored.
	 */
	carriedBudgets?: readonly string[];
	className?: string;
}

export function ThresholdVerdict({
	verdict,
	runId,
	stopped,
	carriedBudgets,
	className,
}: ThresholdVerdictProps) {
	if (!verdict || verdict.checks.length === 0) return null;

	const failed = verdict.failed > 0;
	// Absent (a pre-#1484 engine) reads as evaluated - that engine never wrote
	// the field and never had the gap it now closes either.
	const unmeasurable = verdict.checks.filter((check) => check.evaluated === false).length;
	const carried = new Set(carriedBudgets);
	// Counted over the checks, not the list: the list is the client's record and
	// can name a key the engine did not judge.
	const carriedCount = verdict.checks.filter((check) => carried.has(check.metric)).length;

	return (
		<Card className={className}>
			<CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
				<CardTitle>Pass/fail budgets</CardTitle>
				{/*
				 * `Badge variant="chip"`, not a hand-rolled span. `chip` is the
				 * one variant that lets a caller own the background without
				 * inheriting a `hover:bg-*` it cannot override - `cn()` is
				 * tailwind-merge, which replaces `bg-*` but treats `hover:bg-*`
				 * as a different group - and going through the primitive is also
				 * what supplies the radius. A box with *no* radius class at all
				 * is pinned square for a user who chose the Rounded setting, and
				 * no source scan can flag that (app/CLAUDE.md, "No bare
				 * `rounded`").
				 *
				 * Text on a tint, never the bare fill as a foreground:
				 * `--status-*` is an indicator token and fails contrast as a
				 * label, so the three-token rule sends the word to `-text`
				 * (docs/design-system.md, "Status tokens").
				 */}
				<Badge
					variant="chip"
					className={cn(
						"font-medium",
						failed
							? "bg-destructive/10 text-destructive-text"
							: "bg-status-success/10 text-status-success-text"
					)}
				>
					{failed ? "Failed" : "Passed"}
				</Badge>
			</CardHeader>
			<CardContent>
				<p className={cn("text-xs text-muted-foreground", stopped ? "mb-1" : "mb-3")}>
					{verdict.passed} of {verdict.passed + verdict.failed} budgets met
					{carriedCount > 0 ? ` (${carriedCount} carried over)` : ""}
					{unmeasurable > 0 ? `, ${unmeasurable} not measurable` : ""}.
				</p>
				{stopped && (
					<p className="mb-3 text-xs text-muted-foreground">{stoppedNote(stopped)}</p>
				)}
				<ul className="space-y-1.5">
					{verdict.checks.map((check) => {
						const meta = THRESHOLD_METRICS[check.metric];
						const unit = meta?.unit ?? "";
						// The comparator has to follow the metric: a throughput
						// floor passes *above* its limit, and printing it with a
						// "≤" would describe the opposite budget from the one the
						// verdict beside it was computed against.
						const comparator = meta?.floor ? "≥" : "≤";
						// A pre-#1484 report has no `evaluated` key at all and reads as
						// measured, the same value that engine effectively assumed.
						const evaluated = check.evaluated !== false;
						const populations = assertionPopulationsNote(check);

						return (
							<li
								key={check.metric}
								className="flex items-baseline justify-between gap-3 text-sm"
							>
								<span className="text-muted-foreground">
									{meta?.label ?? check.metric}
									<span className="ml-1.5 text-xs">
										({comparator} {formatValue(check.limit)}
										{unit})
									</span>
									{carried.has(check.metric) && (
										<Badge
											variant="outline"
											className="ml-1.5 px-1.5 py-0 font-normal text-muted-foreground"
										>
											carried over
										</Badge>
									)}
									{populations && (
										<span className="mt-0.5 block text-xs">{populations}</span>
									)}
								</span>
								<span className="flex items-center gap-1.5">
									<span
										className={cn(
											"font-mono font-medium",
											check.passed
												? "text-status-success-text"
												: "text-destructive-text"
										)}
									>
										{evaluated ? (
											<>
												{formatValue(check.actual ?? 0)}
												{unit}
											</>
										) : (
											"no samples"
										)}
									</span>
									{runId !== undefined && (
										<CopyForAgentButton
											reference={thresholdReference(
												{ key: check.metric },
												{ type: "run", run: { id: runId } }
											)}
											label={`Copy ${meta?.label ?? check.metric} budget for agent`}
										/>
									)}
								</span>
							</li>
						);
					})}
				</ul>
			</CardContent>
		</Card>
	);
}
