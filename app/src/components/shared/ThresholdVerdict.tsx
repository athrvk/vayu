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
 * Two surfaces show it - the live dashboard's report view and the history
 * detail's Overview - so it lives here once rather than being written twice and
 * drifting. Silent when the run declared no budgets: an absent section says
 * "not judged", which is a different claim from "judged and passed nothing" and
 * is the reason a run without budgets renders exactly as it did before.
 */

import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { RunReport } from "@/types/domain";

/**
 * How each budget reads on screen. Keyed by the engine's metric name, which
 * travels verbatim from `POST /runs` through the stored summary to the report -
 * a metric this build has no row for still renders, under its raw key, rather
 * than vanishing from a verdict whose counts include it.
 */
const METRIC_LABELS: Record<string, { label: string; unit: string; floor?: boolean }> = {
	latencyP50Ms: { label: "p50 latency", unit: "ms" },
	latencyP95Ms: { label: "p95 latency", unit: "ms" },
	latencyP99Ms: { label: "p99 latency", unit: "ms" },
	maxErrorRatePct: { label: "Error rate", unit: "%" },
	minThroughputRps: { label: "Throughput", unit: "req/s", floor: true },
};

/** Trailing zeros are noise on a budget the user typed as a whole number. */
function formatValue(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export interface ThresholdVerdictProps {
	verdict: RunReport["thresholdValidation"];
	className?: string;
}

export function ThresholdVerdict({ verdict, className }: ThresholdVerdictProps) {
	if (!verdict || verdict.checks.length === 0) return null;

	const failed = verdict.failed > 0;

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
				<p className="mb-3 text-xs text-muted-foreground">
					{verdict.passed} of {verdict.passed + verdict.failed} budgets met.
				</p>
				<ul className="space-y-1.5">
					{verdict.checks.map((check) => {
						const meta = METRIC_LABELS[check.metric];
						const unit = meta?.unit ?? "";
						// The comparator has to follow the metric: a throughput
						// floor passes *above* its limit, and printing it with a
						// "≤" would describe the opposite budget from the one the
						// verdict beside it was computed against.
						const comparator = meta?.floor ? "≥" : "≤";

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
								</span>
								<span
									className={cn(
										"font-mono font-medium",
										check.passed
											? "text-status-success-text"
											: "text-destructive-text"
									)}
								>
									{formatValue(check.actual)}
									{unit}
								</span>
							</li>
						);
					})}
				</ul>
			</CardContent>
		</Card>
	);
}
