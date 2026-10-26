/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * OverviewTab Component
 *
 * Displays the key-metric glance, summary statistics, verdicts, status codes
 * and errors. The run's request and configuration sit above the tabs, in
 * `LoadTestDetail`'s scrolling body.
 */

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format-number";
import {
	CapacitySummary,
	ContractCoverage,
	CustomMetricsSummary,
	ErrorSummary,
	ExactAssertionsSummary,
	type ErrorRowTarget,
	RequestElementsSummary,
	RunWarnings,
	SampledSchemaValidation,
	ScriptLifecycleSummary,
	TestValidationSummary,
	ThresholdVerdict,
	TransactionsSummary,
	exactAssertionsOf,
	replayScopeOf,
	stoppedRunOf,
	testValidationTitleOf,
	CancelledRequestsNote,
} from "@/components/shared";
import { HeroRow } from "@/modules/dashboard/components/hero/HeroRow";
import { ModeStatsRow } from "@/modules/dashboard/components/stats/ModeStatsRow";
import { RunEvents } from "./RunEvents";
import RunKeyMetrics from "./RunKeyMetrics";
import { UnrecordedFiguresNotice } from "./UnrecordedFiguresNotice";
import { unrecordedFiguresOf } from "./unrecorded-figures";
import { SlowRequestsCard } from "./SlowRequestsCard";
import { extractTestFailures, sampleResultsWithoutValidationRow } from "../test-validation";
import { locateSample, numberByTime, type SampleDestination } from "../sample-filter";
import { useHostSleeps } from "@/stores/host-sleep-store";
import type { TabProps } from "../../types";
import { httpStatusClass, statusCodeLabel, STATUS_CLASS_STYLE } from "@/constants/http-status";

interface OverviewTabProps extends TabProps {
	/**
	 * Opens the Samples tab at the first loaded sample an error row counts (#2213).
	 * Absent, the error rows are plain text.
	 */
	onOpenSample?: (destination: SampleDestination) => void;
}

export default function OverviewTab({
	report,
	runId,
	derived,
	anomalies,
	onOpenSample,
}: OverviewTabProps) {
	// Read by run id rather than passed down: `PerformanceTab` reads the same
	// list for the chart marks, and one prop drilled through `LoadTestDetail`
	// for two independent readers is a copy waiting to disagree (#1357).
	const hostSleeps = useHostSleeps(runId);
	// The named failures live on a synthetic result row, not on `testValidation`;
	// lifted here so the Overview says which assertions failed while the Samples
	// tab drops the row rather than drawing it as a request that never ran.
	const testFailures = extractTestFailures(report.results);
	// The rows the Samples tab will show, numbered the way it numbers them, so a
	// destination's row number names the same sample there.
	const sampleRows = useMemo(
		() => numberByTime(sampleResultsWithoutValidationRow(report.results)),
		[report.results]
	);
	const openSample = (target: ErrorRowTarget) => {
		const destination = locateSample(sampleRows, target);
		if (destination) onOpenSample?.(destination);
	};

	const unrecorded = unrecordedFiguresOf(report.summary);
	// Every card in these two rows reads at least one figure the engine did not
	// record for a flagged run (latency, peak concurrency, queue wait, or the
	// counts themselves), and each would draw it as a measured 0. The tiles above
	// and the status and error blocks below carry the counts that do exist.
	const showGlance = !unrecorded.counts && !unrecorded.latency;

	return (
		<>
			<UnrecordedFiguresNotice summary={report.summary} />

			{/* The p99-led glance, then the mode-adaptive summary - same hero cards +
			    stat row the live dashboard shows. Config and request URL/method sit
			    above the tabs, so no separate "Test Configuration" card here. */}
			<RunKeyMetrics report={report} />
			{showGlance && (
				<>
					<HeroRow d={derived} />
					<ModeStatsRow d={derived} />
				</>
			)}

			{/* Above the verdict it would otherwise hide behind: a run that sent
			    every request with an unresolved variable, or skipped a
			    pre-request script, still passes its budgets and still reads
			    green below. Absent for a run with nothing to report. */}
			<RunWarnings warnings={report.warnings} />

			{/* Directly under the numbers it judges - the verdict is the first
			    question a stored run is opened to answer. Absent for a run that
			    declared no budgets, which is every run recorded before them. */}
			<ThresholdVerdict
				verdict={report.thresholdValidation}
				runId={report.metadata?.runId}
				stopped={stoppedRunOf(report)}
				carriedBudgets={report.metadata?.configuration?.carriedBudgets}
			/>

			{/* The run's own named trends, counters and rates (issue #1500),
			    directly under the budgets they are not judged against - these
			    are reported, not scored. Absent for a run that never called
			    pm.metrics or metric.record. */}
			<CustomMetricsSummary customMetrics={report.customMetrics} />

			{/* A folder's members, summed into one latency distribution per
			    pass (issue #1515) - beside the other per-run numbers rather
			    than in the step breakdown, since a transaction spans a
			    folder, not one step. Absent for a collection with no
			    control.transaction element. */}
			<TransactionsSummary transactions={report.scenario?.transactions} />

			{/* What the search found, for a capacity run. Beside the verdict
			    rather than below the charts: "what can it take" is the question
			    the run was started to answer. Absent for every other mode. */}
			<CapacitySummary
				capacity={report.capacity}
				stepDuration={report.metadata?.configuration?.stepDuration}
			/>

			{/* Whether the run touched the contract it was measured against.
			    Beside the verdict rather than below the charts, and for the same
			    reason: a run can meet every budget while never calling four of
			    eighteen operations. Absent for a run of an unbound collection. */}
			<ContractCoverage
				coverage={report.coverage}
				inheritedBinding={report.metadata?.openapi?.inherited}
			/>

			{/* And whether what came back honoured that contract. Directly under
			    coverage because the two answer halves of one question against the
			    same document - what was exercised, and what it returned. Absent
			    for a run that checked nothing. */}
			<SampledSchemaValidation validation={report.schemaValidation} />

			{/* What script.setup / script.teardown did, once each, at the run's
			    own boundary. Absent for a run whose collection declared
			    neither. */}
			<ScriptLifecycleSummary lifecycle={report.lifecycle} />

			{/* A single-request run's own extractor, assertion and timer
			    outcomes (issue #1594/#1641) - a scenario run reports its
			    per-step elements in the Steps tab instead, so this is absent
			    there. */}
			<RequestElementsSummary elements={report.elements} />

			{/* A scenario load run's assertions counted on every response
			    (#2820), ahead of the sampled replay below: it is the exact
			    figure, and the HTTP numbers above cannot say it. Absent for a
			    run that made none, which then keeps the card below as it was. */}
			<ExactAssertionsSummary assertions={exactAssertionsOf(report)} />

			{/* Whether the run's own assertions passed, and which failed. The
			    schema block above judges the response against a contract; this
			    judges it against the run's pm.test scripts - the same distinction
			    the live dashboard draws. Absent for a run that asserted nothing,
			    so a run without tests reads exactly as it did before this block. */}
			<TestValidationSummary
				testValidation={report.testValidation}
				sampling={report.sampling}
				failures={testFailures?.messages}
				failuresTotal={testFailures?.total}
				// A sequence's requests mostly carry no script, so the run's total is
				// no denominator for the replay (#2824); a scenario report with no
				// deferred script states none rather than that one.
				totalRequests={report.scenario ? undefined : report.summary.totalRequests}
				replayScope={replayScopeOf(report)}
				title={testValidationTitleOf(report)}
			/>

			{/* When the run went wrong, in words. Above the status/error totals
			    because those are cumulative and this is the thing they hide: a
			    3-second collapse and a steady 0.4% failure rate can produce the
			    same summary row. */}
			<RunEvents anomalies={anomalies} sleeps={hostSleeps} />

			{/* Status Codes */}
			{report.statusCodes && Object.keys(report.statusCodes).length > 0 && (
				<Card className="enter-fade">
					<CardHeader>
						<CardTitle>Status code distribution</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-2 @md:grid-cols-3 @3xl:grid-cols-4 gap-3">
							{Object.entries(report.statusCodes).map(
								([code, count]: [string, number]) => {
									/*
									 * One vocabulary, from `constants/http-status`. These tiles
									 * used raw palette classes and their own branches, which put
									 * 3xx on blue while the badge said amber and the chart said
									 * violet - and painted a 5xx and a connection failure the
									 * same red, so "the server erred" and "there was no server"
									 * were indistinguishable at a glance.
									 */
									const style = STATUS_CLASS_STYLE[httpStatusClass(Number(code))];

									return (
										<div
											key={code}
											className={cn(
												"p-3 border border-rule text-center",
												style.tint
											)}
										>
											<p
												className={cn(
													"text-lg font-bold font-mono mb-0.5",
													style.text
												)}
											>
												{statusCodeLabel(Number(code))}
											</p>
											<p className="text-xs text-muted-foreground">
												{formatNumber(count)} reqs
											</p>
										</div>
									);
								}
							)}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Outside every count above and below; a stopped run can have this and no errors. */}
			<CancelledRequestsNote count={report.summary.cancelledRequests} />

			<ErrorSummary
				errors={report.errors}
				errorRate={report.summary.errorRate}
				httpErrors={derived.httpErrors}
				noResponse={derived.noResponse}
				onSelectStatus={onOpenSample && ((code) => openSample({ kind: "status", code }))}
				onSelectErrorType={
					onOpenSample && ((key) => openSample({ kind: "errorType", key }))
				}
				hasSamples={(target) => locateSample(sampleRows, target) !== null}
				sampling={report.sampling}
			/>

			{/* Past the totals and the verdicts: this is the count behind the
			    Samples tab's "Slow" chip. Absent when no request crossed the
			    threshold, or the run set none. */}
			<SlowRequestsCard slowRequests={report.slowRequests} />
		</>
	);
}
