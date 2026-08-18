/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A load run's aggregate test-validation outcome - how many sampled responses
 * were asserted against, and how many of those assertions passed (issue #726).
 *
 * The engine writes `testValidation` (`run_manager.cpp` -> `runs.cpp`) into
 * every load-run report whose plan carried a post-request script, and stores
 * the named per-test failures on a synthetic result row. Before #726 the only
 * reader of either was the live dashboard's `RequestResponseView`, mounted only
 * while a run was being watched - so a run reopened from History showed
 * thresholds, status codes and schema validation but never said whether its
 * assertions ran at all. This is the one block, rendered by both surfaces.
 *
 * **`failures` is the History half only.** The live dashboard lists each named
 * failure beside the sample it came from, so it passes the aggregate alone; the
 * History Overview has no per-sample failure surface (its failure row is
 * filtered out of the Samples tab, see `test-validation.ts`), so it passes the
 * failures here. The stats card renders on the same `testValidation` both draw
 * from, so the two cannot disagree on the numbers.
 */

import { XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import { SampleRetentionNote } from "./SampleRetentionNote";
import type { RunReport } from "@/types/domain";

export interface TestValidationSummaryProps {
	testValidation: RunReport["testValidation"];
	sampling: RunReport["sampling"];
	/**
	 * The named per-test failures the run recorded, from the synthetic
	 * failure-detail result row (`run_manager.cpp` stores it with `status 0`).
	 * The list is bounded engine-side, so {@link failuresTotal} is the true
	 * count and a shorter list says so out loud rather than reading as the whole
	 * set. Omitted by surfaces that already list failures per sample.
	 */
	failures?: string[];
	failuresTotal?: number;
	className?: string;
}

export function TestValidationSummary({
	testValidation,
	sampling,
	failures,
	failuresTotal,
	className,
}: TestValidationSummaryProps) {
	const hasFailures = failures !== undefined && failures.length > 0;

	// A run that asserted nothing has no `testValidation` at all - absent, never
	// a row of zeros - and with no failures to name there is nothing to show. A
	// report old enough to omit the block reads the same as a run without tests.
	if (!testValidation && !hasFailures) return null;

	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle className="text-lg">Test Validation</CardTitle>
			</CardHeader>
			<CardContent>
				{testValidation && (
					<>
						<div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3">
							<div>
								<p className="text-sm text-muted-foreground">Samples Tested</p>
								<p className="font-bold">{testValidation.samplesTested}</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Passed</p>
								<p className="font-bold text-status-success-text">
									{testValidation.testsPassed}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Failed</p>
								<p className="font-bold text-destructive-text">
									{testValidation.testsFailed}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Success Rate</p>
								<p className="font-bold">
									{testValidation.successRate.toFixed(1)}%
								</p>
							</div>
						</div>
						<SampleRetentionNote
							sampling={sampling}
							shown={testValidation.samplesTested}
							budget="responses"
							className="mt-3"
						/>
					</>
				)}

				{/*
				 * The named failures, so a run that failed 13 of 100 assertions is
				 * not indistinguishable from one that asserted nothing. Modelled on
				 * the request-builder Tests tab and the live dashboard's per-sample
				 * list, so the same failure reads the same wherever it is shown.
				 */}
				{hasFailures && (
					<div className={cn("space-y-1", testValidation && "mt-4")}>
						<p className="text-xs font-medium text-muted-foreground">
							Failed Tests
							{failuresTotal !== undefined && (
								<span className="ml-1">({failuresTotal})</span>
							)}
						</p>
						<div className="space-y-1.5">
							{failures.map((failure, i) => (
								<div
									key={i}
									className="flex items-start gap-2 bg-status-error/10 border border-status-error/20 rounded-md p-2"
								>
									<XCircle className="w-4 h-4 text-status-error-text mt-0.5 shrink-0" />
									<pre className="text-xs text-status-error-text font-mono whitespace-pre-wrap break-words flex-1 min-w-0">
										{failure}
									</pre>
								</div>
							))}
						</div>
						{/*
						 * Said out loud when the stored list is shorter than the count:
						 * a list of ten under a count of forty reads as the whole set of
						 * problems unless it says otherwise (the SampledSchemaValidation
						 * precedent beside it).
						 */}
						{failuresTotal !== undefined && failuresTotal > failures.length && (
							<p className="mt-2 text-xs text-muted-foreground tabular-nums">
								Showing {failures.length} of {failuresTotal}.
							</p>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
