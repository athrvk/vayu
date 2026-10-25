/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A load run's aggregate test-validation outcome - how many sampled responses
 * were asserted against, and how many of those assertions passed (issue #726).
 * Two units share the card and the labels name them: responses tested is a
 * count of responses, passed and failed are counts of assertions (issue #2144).
 *
 * The engine writes `testValidation` (`run_manager.cpp` -> `runs.cpp`) into
 * every load-run report whose plan carried a post-request script, and stores
 * the named per-test failures on a synthetic result row. Before #726 the only
 * reader of either was the dashboard's own report view, mounted only while a
 * run was being watched - so a run reopened from History showed thresholds,
 * status codes and schema validation but never said whether its assertions ran
 * at all. The History Overview renders this block, and the dashboard shows that
 * Overview for a finished run (#2220).
 *
 * **`failures` lists the named failures.** The Overview passes them because
 * the synthetic failure row is filtered out of the Samples tab (see
 * `test-validation.ts`), so this is the one place they reach the screen.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { formatNumber, formatPercent } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { Callout } from "./Callout";
import { SampleRetentionNote } from "./SampleRetentionNote";
import { TEST_VALIDATION_TITLE } from "./run-assertions";
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
	/**
	 * The run's total request count, `summary.totalRequests`. With it the card
	 * says how many of the run's requests were tested; without it the card says
	 * nothing about the denominator rather than guess one (never "of 0").
	 */
	totalRequests?: number;
	/**
	 * The card's title; `testValidationTitleOf` answers it (#2820), retitling the
	 * card when `ExactAssertionsSummary` sits beside it.
	 */
	title?: string;
	className?: string;
}

/**
 * The tested-of-total line. `samplesTested` counts responses, `totalRequests`
 * counts requests, and the gap is not only the retention limit's doing: a
 * request that errored before a response arrived has nothing to test. The
 * sentence says the rest "had no response or were not kept" so it holds for
 * either cause; the uniformity of what was kept is `SampleRetentionNote`'s to
 * state, because only it knows whether the byte budget was spent.
 */
function testedLine(samplesTested: number, totalRequests: number): string {
	if (samplesTested >= totalRequests) {
		return `Tested all ${formatNumber(totalRequests)} requests.`;
	}
	return `Tested ${formatNumber(samplesTested)} of ${formatNumber(totalRequests)} requests. The rest had no response or were not kept.`;
}

export function TestValidationSummary({
	testValidation,
	sampling,
	failures,
	failuresTotal,
	totalRequests,
	title = TEST_VALIDATION_TITLE,
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
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent>
				{testValidation && (
					<>
						<div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3">
							<div>
								<p className="text-sm text-muted-foreground">Responses tested</p>
								<p className="font-bold">
									{formatNumber(testValidation.samplesTested)}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Assertions passed</p>
								<p className="font-bold text-status-success-text">
									{formatNumber(testValidation.testsPassed)}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Assertions failed</p>
								<p className="font-bold text-destructive-text">
									{formatNumber(testValidation.testsFailed)}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">
									Assertion success rate
								</p>
								<p className="font-bold">
									{formatPercent(testValidation.successRate)}%
								</p>
							</div>
						</div>
						{totalRequests !== undefined && totalRequests > 0 && (
							<p className="mt-3 text-xs text-muted-foreground tabular-nums">
								{testedLine(testValidation.samplesTested, totalRequests)}
							</p>
						)}
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
				 * the request-builder Tests tab and the sample row's failure list,
				 * so the same failure reads the same wherever it is shown.
				 */}
				{hasFailures && (
					<div className={cn("space-y-1", testValidation && "mt-4")}>
						<p className="text-xs font-medium text-muted-foreground">
							Failed tests
							{failuresTotal !== undefined && (
								<span className="ml-1">({formatNumber(failuresTotal)})</span>
							)}
						</p>
						<div className="space-y-1.5">
							{failures.map((failure, i) => (
								<Callout key={i} severity="blocking">
									<pre className="font-mono whitespace-pre-wrap break-words">
										{failure}
									</pre>
								</Callout>
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
								Showing {formatNumber(failures.length)} of{" "}
								{formatNumber(failuresTotal)}.
							</p>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
