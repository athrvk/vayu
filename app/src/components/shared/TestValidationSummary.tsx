/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A load run's aggregate test-validation outcome: how many sampled responses were asserted against,
 * and how many assertions passed (#726). Two units share the card, and the labels name them:
 * responses tested counts responses, passed and failed count assertions (#2144). The engine writes
 * `testValidation` (`run_manager.cpp` -> `runs.cpp`) into every load-run report whose plan carried
 * a post-request script, and stores the named per-test failures on a synthetic result row. The
 * History Overview renders this, which the dashboard shows for a finished run (#2220), so a
 * reopened run says whether its assertions ran.
 *
 * **`failures` lists the named failures**: the synthetic row is filtered out of the Samples tab
 * (`test-validation.ts`), so this is the one place they reach the screen. Each distinct message is
 * listed once with its count (#3127): a script failing alike on every sampled response is one line,
 * `x1,000`. **The replay's console lines close the card** (#3127), under a heading naming the
 * replay and its sample size; they ride inside `testValidation`, so an older engine's report has
 * none.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { formatNumber, formatPercent } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { Callout } from "./Callout";
import { OccurrenceCount } from "./OccurrenceCount";
import { ReplayConsole } from "./ReplayConsole";
import { SampleRetentionNote } from "./SampleRetentionNote";
import { pluralize } from "@/modules/dashboard/utils/format";
import { TEST_VALIDATION_TITLE, type ReplayScope } from "./run-assertions";
import type { RunReport } from "@/types/domain";

export interface TestValidationSummaryProps {
	testValidation: RunReport["testValidation"];
	sampling: RunReport["sampling"];
	/**
	 * The named per-test failures, from the synthetic failure-detail row (`run_manager.cpp` stores
	 * it with `status 0`). Bounded engine-side, so {@link failuresTotal} is the true count and a
	 * shorter list says so aloud. Omitted by surfaces listing failures per sample.
	 */
	failures?: string[];
	/**
	 * How often each of {@link failures} failed, parallel to it; above 1 is shown beside the
	 * message, and absent on a row stored before deduplication, whose every entry is one.
	 */
	failureCounts?: number[];
	/** Failed assertions, each occurrence counted - not the length of {@link failures}. */
	failuresTotal?: number;
	/**
	 * Every distinct message the replay saw, kept or not; above `failures.length` the card says how
	 * many of how many it shows. Absent on an old row, judged by {@link failuresTotal}.
	 */
	failuresDistinct?: number;
	/**
	 * The run's `summary.totalRequests`: with it the card says how many requests were tested;
	 * without it, nothing about the denominator rather than a guess (never "of 0").
	 */
	totalRequests?: number;
	/**
	 * For a scenario load run, the responses carrying a deferred test script (`replayScopeOf`,
	 * #2824), the denominator there rather than {@link totalRequests}: most of a sequence's
	 * requests have no script, so "the rest were not kept" would be untrue. Pass one or the other;
	 * this wins if both.
	 */
	replayScope?: ReplayScope;
	/**
	 * The card's title, from `testValidationTitleOf` (#2820), which retitles it beside
	 * `ExactAssertionsSummary`.
	 */
	title?: string;
	className?: string;
}

/**
 * The tested-of-total line. `samplesTested` counts responses and `totalRequests` requests, and not
 * only retention makes the gap (a request that errored before a response has nothing to test), so
 * the rest "had no response or were not kept". Whether the kept set is uniform is
 * `SampleRetentionNote`'s to say, as only it knows whether the byte budget was spent.
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
			<OccurrenceCount count={count} />
		</div>
	);
}

/**
 * The "Showing X of Y" line, or `null` when the list is whole. A row with `failuresDistinct` lists
 * distinct messages, so its denominator is distinct ones (`failuresTotal` counts occurrences
 * there); an older row listed one entry per occurrence, so its total still serves.
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

	// A run that asserted nothing has no `testValidation` (absent, never zeros), and without
	// failures there is nothing to show; a report old enough to omit the block reads the same.
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
				 * The named failures, so a run failing 13 of 100 assertions is not
				 * indistinguishable from one asserting nothing; shaped like the request-builder
				 * Tests tab and a sample row's failure list, so a failure reads the same
				 * everywhere.
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
						 * Said aloud when the stored list is shorter than its count: ten under
						 * forty reads as the whole set of problems otherwise (as
						 * `SampledSchemaValidation` does).
						 */}
						{shownCue && (
							<p className="mt-2 text-xs text-muted-foreground tabular-nums">
								{shownCue}
							</p>
						)}
					</div>
				)}

				{/*
				 * The replay's console lines (#3127), a member of `testValidation`, so never
				 * outliving the block above.
				 */}
				<ReplayConsole
					source={testValidation}
					sampled={testValidation?.samplesTested}
					className="mt-4"
				/>
			</CardContent>
		</Card>
	);
}
