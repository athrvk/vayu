/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The run's verdict against its declared pass/fail budgets: the aggregate half of the judgement, as
 * a test script asserts one response at a time and cannot say whether the p99 or error rate met a
 * budget, so a run passing every assertion can miss what it was run to check. Shown by the history
 * Overview, the dashboard's view of a finished run (#2220). Silent without budgets: absent says
 * "not judged", another claim from "judged and passed nothing". A check can be unmeasurable
 * (#1484): a latency ceiling over zero completed requests has no number, and "0ms" would read as a
 * real, passing measurement.
 */

import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { thresholdReference } from "@/lib/agent-reference";
import { formatFixed, formatNumber } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { formatDuration, pluralize } from "@/modules/dashboard/utils/format";
import type { AssertionPopulation, RunReport } from "@/types/domain";
import { CopyForAgentButton } from "./CopyForAgentButton";
import type { StoppedRun } from "./stopped-run";
import { THRESHOLD_METRICS } from "./threshold-metrics";

/** Trailing zeros are noise on a budget the user typed as a whole number. */
function formatValue(value: number): string {
	return Number.isInteger(value) ? String(value) : formatFixed(value, 2);
}

/** Prose-sized: "3s", "1m", never "1m 0s". */
function formatSpan(seconds: number): string {
	return formatDuration(seconds * 1000, { omitZeroUnit: true });
}

/**
 * The pass/fail counts are the engine's; this says how much of the plan they covered. The planned
 * span is dropped once the run reached it (a stop in the last instant), where "of a planned" would
 * describe a shortfall that did not happen.
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
 * `sampleRate` is a keep-1-in-N period, absent only if a sidecar omitted it; the wording names the
 * period, not a share, as the reservoir cap can leave a long run's replayed set sparser than 1 in
 * N.
 */
function sampledScope(sampleRate: number | undefined): string {
	if (sampleRate === undefined) return "on sampled responses";
	if (sampleRate === 1) return "on every response";
	return `on responses sampled at 1 in ${formatNumber(sampleRate)}`;
}

/**
 * Which population the assertion budget's verdict came from (#2892): it judges the worse of the
 * exact inline tally and the sampled `pm.test` replay, as a blended rate would hide a sampled test
 * failing every time. Silent unless the sampled population ran, so older reports and runs without a
 * test script read as before.
 */
function assertionPopulationsNote(check: Check): string | null {
	const { assertionsExact: exact, assertionsSampled: sampled, sampleRate } = check;
	// An unmeasurable row reads "no samples", which a population line would contradict.
	if (check.evaluated === false) return null;
	if (!sampled || sampled.passed + sampled.failed === 0) return null;
	const sampledPhrase = populationPhrase(sampled, sampledScope(sampleRate));
	if (!exact || exact.passed + exact.failed === 0) return `Judged on ${sampledPhrase}.`;
	return `Judged on the worse of ${populationPhrase(exact, "on every response")} and ${sampledPhrase}.`;
}

export interface ThresholdVerdictProps {
	verdict: RunReport["thresholdValidation"];
	/** For a stopped run (`stoppedRunOf`): the card says the verdict covers only what ran. */
	stopped?: StoppedRun;
	/** The run that was judged; each check's "Copy for agent" is absent without it. */
	runId?: string;
	/**
	 * The `thresholds` keys the client sent as carried over rather than set (#2195), from
	 * `metadata.configuration.carriedBudgets`: a listed check is tagged, a listed key with no check
	 * ignored.
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
	// Absent (a pre-#1484 engine) reads as evaluated: that engine never wrote the field nor had the
	// gap.
	const unmeasurable = verdict.checks.filter((check) => check.evaluated === false).length;
	const carried = new Set(carriedBudgets);
	// Counted over the checks, not the list, which is the client's record and can name an unjudged
	// key.
	const carriedCount = verdict.checks.filter((check) => carried.has(check.metric)).length;

	return (
		<Card className={className}>
			<CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
				<CardTitle>Pass/fail budgets</CardTitle>
				{/*
				 * `Badge variant="chip"`, not a hand-rolled span: `chip` lets a caller own the
				 * background without a `hover:bg-*` it cannot override (`cn()`'s tailwind-merge
				 * replaces `bg-*` but files `hover:bg-*` apart), and the primitive supplies the
				 * radius: a box with none is square for a Rounded user, which no source scan flags
				 * (app/CLAUDE.md, "No bare `rounded`"). Text on a tint, never the bare fill as
				 * foreground: `--status-*` is an indicator token failing contrast as a label, so
				 * the word takes `-text` (docs/design-system/accent-and-status.md, "Status
				 * tokens").
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
						// The comparator follows the metric: a throughput floor passes *above* its
						// limit, and "≤" would describe the opposite budget from the one judged.
						const comparator = meta?.floor ? "≥" : "≤";
						// A pre-#1484 report has no `evaluated` key and reads as measured, as that
						// engine assumed.
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
