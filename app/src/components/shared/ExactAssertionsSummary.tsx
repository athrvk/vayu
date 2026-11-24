/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A scenario load run's assertions counted on every response (#2820): passed, failed, and the
 * failure rate. The report's `scenario.assertions`, the exact population (`assert.*` outcomes,
 * required `extract.*` misses, inline `pm.test` calls), where `TestValidationSummary` beside it
 * reports the sampled replay of scripts that did not run inline. A different population from the
 * HTTP figures above, which is the point: a run whose every assertion failed against `200`s has
 * 100.0% success and 0.0% errors, and the failures show here. **Silent without an exact assertion**
 * (`undefined`), so a single-request run, a collection run and an older report render unchanged.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { formatNumber } from "@/lib/format-number";
import { formatErrorRate } from "./run-outcome";
import type { ExactAssertions } from "./run-assertions";

export interface ExactAssertionsSummaryProps {
	assertions: ExactAssertions | undefined;
	className?: string;
}

export function ExactAssertionsSummary({ assertions, className }: ExactAssertionsSummaryProps) {
	if (!assertions) return null;
	const { passed, failed } = assertions;
	const total = passed + failed;
	const failureRate = total > 0 ? (failed / total) * 100 : 0;

	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle>Assertions</CardTitle>
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
						<p className="font-bold">{formatErrorRate(failureRate)}</p>
					</div>
				</div>
				<p className="mt-3 text-xs text-muted-foreground">
					Counted on every response, not a sample.
				</p>
			</CardContent>
		</Card>
	);
}
