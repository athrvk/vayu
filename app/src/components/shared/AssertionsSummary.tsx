/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A scenario load run's exact assertion tally (issue #2820): every `assert.*`
 * outcome and inline `pm.test` call, counted on every response.
 *
 * **Not the Sampled replay card.** `TestValidationSummary` is the deferred
 * replay of a sample of responses, so its figures are a sample; this one is the
 * whole run, and the caption says so. Neither moves `scenario.passed` /
 * `failed` or the Success rate, which stay HTTP outcomes - a run can answer
 * every request 200 and fail every assertion.
 *
 * Silent when the report carries no tally (a run stored before it, or a
 * collection run) and when it counted nothing: absent is not "0 failed", and
 * a card of zeros would claim the run asserted something.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui";
import { formatNumber } from "@/lib/format-number";
import type { RunReport } from "@/types/domain";
import { formatErrorRate } from "./run-outcome";

export interface AssertionsSummaryProps {
	assertions: NonNullable<RunReport["scenario"]>["assertions"];
	className?: string;
}

export function AssertionsSummary({ assertions, className }: AssertionsSummaryProps) {
	if (!assertions) return null;
	const { passed, failed } = assertions;
	const total = passed + failed;
	if (total <= 0) return null;

	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle>Assertions</CardTitle>
				<CardDescription>Counted on every response</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3">
					<div>
						<p className="text-sm text-muted-foreground">Passed</p>
						<p className="font-bold text-status-success-text">{formatNumber(passed)}</p>
					</div>
					<div>
						<p className="text-sm text-muted-foreground">Failed</p>
						<p className="font-bold text-destructive-text">{formatNumber(failed)}</p>
					</div>
					<div>
						<p className="text-sm text-muted-foreground">Failure rate</p>
						<p className="font-bold">{formatErrorRate((failed / total) * 100)}</p>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
