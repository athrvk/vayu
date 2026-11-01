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
 * `test-validation.ts`), so this is the one place they reach the screen. Each
 * distinct message is listed once with how often it failed (#3127): a script
 * failing the same way on every sampled response is one line, `x1,000`.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { formatNumber, formatPercent } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { Callout } from "./Callout";
import { SampleRetentionNote } from "./SampleRetentionNote";
import { pluralize } from "@/modules/dashboard/utils/format";
import { TEST_VALIDATION_TITLE, type ReplayScope } from "./run-assertions";
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
	/**
	 * How many times each of {@link failures} failed, parallel to it. A count
	 * above 1 is shown beside the message; absent on a row stored before the
	 * engine deduplicated, whose every entry stands for one.
	 */
	failureCounts?: number[];
	/** Failed assertions, each occurrence counted - not the length of {@link failures}. */
	failuresTotal?: number;
	/**
	 * Every distinct message the replay saw, kept or not. When it exceeds
	 * `failures.length` the card says how many of how many it shows; absent on an
	 * old row, which is judged by {@link failuresTotal} as it always was.
	 */
	failuresDistinct?: number;
	/**
	 * The run's total request count, `summary.totalRequests`. With it the card
	 * says how many of the run's requests were tested; without it the card says
	 * nothing about the denominator rather than guess one (never "of 0").
	 */
	totalRequests?: number;
	/**
	 * For a scenario load run, the responses that carried a deferred test script
	 * (`replayScopeOf`, #2824). It is the denominator there, not
	 * {@link totalRequests}: most requests of a sequence have no script to
	 * replay, so "the rest were not kept" would be untrue of them. A caller
	 * passes one or the other; this one wins if both arrive.
	 */
	replayScope?: ReplayScope;
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

/** The same line for a scenario run, over the responses that had a script to replay. */
function replayedLine(samplesTested: number, scope: ReplayScope): string {
	const steps = `${formatNumber(scope.steps)} ${pluralize(scope.steps, "step")}`;
	const population = `responses that carried a test script (${steps})`;
	const head =
		samplesTested >= scope.responses
			? `Replayed all ${formatNumber(scope.responses)} ${population}.`
			: `Replayed ${formatNumber(samplesTested)} of the ${formatNumber(scope.responses)} ${population}.`;
	return scope.assertionsCounted
		? `${head} Assertions that ran inline are counted under Assertions.`
		: head;
}

/** The line under the four tallies, or `null` where there is no denominator to state. */
function coverageLine(
	samplesTested: number,
	totalRequests: number | undefined,
	replayScope: ReplayScope | undefined
): string | null {
	if (replayScope) return replayedLine(samplesTested, replayScope);
	if (totalRequests !== undefined && totalRequests > 0) {
		return testedLine(samplesTested, totalRequests);
	}
	return null;
}

/** One failure: the message, and `x3` beside it when it failed more than once. */
function FailureLine({ message, count }: { message: string; count: number | undefined }) {
	return (
		<div className="flex items-start gap-3">
			<pre className="min-w-0 flex-1 font-mono whitespace-pre-wrap break-words">
				{message}
			</pre>
			{count !== undefined && count > 1 && (
				<span className="shrink-0 font-mono tabular-nums">x{formatNumber(count)}</span>
			)}
		</div>
	);
}

/**
 * The "Showing X of Y" line, or `null` when the list is whole. A row that
 * carries `failuresDistinct` lists distinct messages, so its denominator is
 * distinct ones; `failuresTotal` counts occurrences there and cannot be set
 * against the list's length. An older row listed one entry per occurrence, so
 * its total still can.
 */
function shownCueOf(
	listed: number,
	total: number | undefined,
	distinct: number | undefined
): string | null {
	if (distinct !== undefined) {
		if (distinct <= listed) return null;
		return `Showing ${formatNumber(listed)} of ${formatNumber(distinct)} distinct.`;
	}
	if (total === undefined || total <= listed) return null;
	return `Showing ${formatNumber(listed)} of ${formatNumber(total)}.`;
}

export function TestValidationSummary({
	testValidation,
	sampling,
	failures,
	failureCounts,
	failuresTotal,
	failuresDistinct,
	totalRequests,
	replayScope,
	title = TEST_VALIDATION_TITLE,
	className,
}: TestValidationSummaryProps) {
	const hasFailures = failures !== undefined && failures.length > 0;

	// A run that asserted nothing has no `testValidation` at all - absent, never
	// a row of zeros - and with no failures to name there is nothing to show. A
	// report old enough to omit the block reads the same as a run without tests.
	if (!testValidation && !hasFailures) return null;

	const shownCue = hasFailures
		? shownCueOf(failures.length, failuresTotal, failuresDistinct)
		: null;
	const coverage =
		testValidation && coverageLine(testValidation.samplesTested, totalRequests, replayScope);

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
						{coverage && (
							<p className="mt-3 text-xs text-muted-foreground tabular-nums">
								{coverage}
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
									<FailureLine message={failure} count={failureCounts?.[i]} />
								</Callout>
							))}
						</div>
						{/*
						 * Said out loud when the stored list is shorter than what it
						 * lists: a list of ten under a count of forty reads as the whole
						 * set of problems unless it says otherwise (the
						 * SampledSchemaValidation precedent beside it).
						 */}
						{shownCue && (
							<p className="mt-2 text-xs text-muted-foreground tabular-nums">
								{shownCue}
							</p>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
