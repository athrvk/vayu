/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** A load run's report, with Overview, Performance and Samples tabs (and Steps for a sequence). */

import { useState, useMemo, useEffect } from "react";
import {
	Activity,
	TrendingUp,
	BarChart3,
	AlertTriangle,
	ListOrdered,
	KeyRound,
	GitCompareArrows,
} from "lucide-react";
import {
	Button,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	TabLabel,
	ScrollArea,
	HeadingSection,
	useHeadingLevel,
} from "@/components/ui";
import { formatNumber } from "@/lib/format-number";
import { runIdentity } from "@/lib/run-reference-input";
import { formatConcurrency } from "@/constants/load-test-modes";
import {
	MethodBadge,
	RunOutcomeBanner,
	SequenceBadge,
	TabBreadcrumb,
	TruncatedText,
	reportOutcome,
	testValidationTitleOf,
} from "@/components/shared";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import { computeBreakpoint } from "@/modules/dashboard/utils/computeBreakpoint";
import { runSloMs } from "@/modules/dashboard/utils/runSloMs";
import { p99AtPeak } from "@/modules/dashboard/utils/p99AtPeak";
import { buildRampOverlay } from "@/modules/dashboard/utils/metricsTransforms";
import { pluralize } from "@/modules/dashboard/utils/format";
import { detectAnomalies } from "@/modules/dashboard/utils/detectAnomalies";
import { useCollectionName } from "@/queries/collections";
import { useRunMonitorSeriesQuery, useRunQuery, useRunTimeSeriesQuery } from "@/queries/runs";
import { useClientSettingsStore, useLayoutStore, useTabsStore } from "@/stores";
import {
	BaselineComparison,
	OverviewTab,
	PerformanceTab,
	RunComparisonView,
	RunConfigSummary,
	RunTrend,
	SamplesTab,
	ScenarioStepsTab,
} from "./components";
import { authRefreshNote } from "./auth-refresh-note";
import type { SampleDestination, SampleFilter } from "./sample-filter";
import { RUN_TYPE_NAME, type LoadTestDetailProps, type SeriesFailure } from "../types";

/**
 * What the request bar says a collection run was: the collection, its length and its concurrency,
 * each only when known. `TruncatedText` measures one string, so the sentence is built, not composed
 * of nodes it would have to flatten.
 */
function describeSequence(target: {
	collectionName?: string;
	stepCount?: number;
	virtualUsers?: number;
}): string {
	const { collectionName, stepCount, virtualUsers } = target;
	return [
		collectionName,
		stepCount === undefined
			? undefined
			: `${formatNumber(stepCount)} ${pluralize(stepCount, "step")} per iteration`,
		virtualUsers === undefined ? undefined : formatConcurrency(virtualUsers),
	]
		.filter(Boolean)
		.join(" - ");
}

export default function LoadTestDetail({ report, runId }: LoadTestDetailProps) {
	// On the dashboard this report is the whole pane and its crumb is the pane's
	// `h1`; in History the run's header is (#3498).
	const titlesPane = useHeadingLevel() === 1;
	const [activeTab, setActiveTab] = useState("overview");
	// Held here, not in SamplesTab: Radix unmounts an inactive panel, so the tab
	// would forget a chip or an open row the moment another tab was chosen. The
	// open row is a one-shot (#2213) - a tab the user picks drops it, so going
	// back to Samples does not re-open what an Overview row once pointed at.
	const [sampleFilter, setSampleFilter] = useState<SampleFilter>("all");
	const [sampleToExpand, setSampleToExpand] = useState<number>();
	const [comparing, setComparing] = useState(false);
	// What happened, beside the protocol the run asked for. A 0 covers both "none downgraded" and
	// "the run predates the count" (the engine does not tell them apart, see the field's doc in
	// types/domain.ts), and neither draws a warning, so folding `undefined` into 0 loses nothing.
	const downgradedRequests = report.summary.httpVersionDowngraded ?? 0;

	/*
	 * A collection load run: `type: "load"` (it publishes ticks and reports percentiles like any
	 * load run), but its target is a sequence, so it has no single method or URL and reports
	 * per-step numbers as a breakdown, not `results[]` rows.
	 *
	 * Two questions, two answers. Whether the run *is* a collection run decides the request bar,
	 * and `metadata.scenario`'s snapshot identity answers it for every such run; a run the engine
	 * did not finish has no stored summary and so no breakdown, and reading the breakdown for this
	 * would name it "GET Unknown URL" (#3569). The breakdown's presence decides the Steps tab
	 * alone, as that is what the tab renders. A report from an engine predating `metadata.scenario`
	 * is recognised by its breakdown instead.
	 */
	const scenarioSteps = report.scenario?.steps;
	const hasStepBreakdown = !!scenarioSteps?.length;
	const scenarioIdentity = report.metadata?.scenario;
	const isCollectionRun = !!scenarioIdentity || hasStepBreakdown;
	const collectionName = useCollectionName(scenarioIdentity?.collectionId);
	// A selection the rendered tabs no longer include (Steps, when the report
	// changes to a single-request run) would match no panel and leave the pane blank.
	const availableTabs = new Set(["overview", "performance", "samples"]);
	if (hasStepBreakdown) availableTabs.add("steps");
	const tab = availableTabs.has(activeTab) ? activeTab : "overview";
	const sequenceLabel = isCollectionRun
		? describeSequence({
				collectionName,
				stepCount: scenarioSteps?.length || scenarioIdentity?.stepCount,
				virtualUsers: report.scenario?.virtualUsers,
			})
		: "";

	// The persisted time series, fetched once here so the Overview stat cards (breakpoint,
	// saturation, derived below) and the Performance charts read the same data from one query. One
	// request, never paged: a long run arrives downsampled (#2547).
	const {
		data: timeSeriesData,
		isLoading: isLoadingSeries,
		isError: isSeriesError,
		error: seriesError,
		refetch: refetchSeries,
	} = useRunTimeSeriesQuery(runId ?? null, report.metadata?.status);

	const seriesFailure = useMemo<SeriesFailure | undefined>(() => {
		if (!isSeriesError) return undefined;
		return {
			message: seriesError?.message ?? "Vayu's engine returned no time-series data.",
			retry: () => void refetchSeries(),
		};
	}, [isSeriesError, seriesError, refetchSeries]);

	const timeSeries = useMemo(() => timeSeriesData?.data ?? [], [timeSeriesData]);
	// Set only when the engine folded the series; the charts say what a point is.
	const ticksPerBucket = timeSeriesData?.bucketed ? timeSeriesData.ticksPerBucket : undefined;

	// Server vitals, only for a run that recorded some: the report's `monitor` section is the run's
	// own record of the scrape, so a run that monitored nothing (or whose every scrape failed)
	// never fetches. One request, never paged, folded by the engine past the History point budget
	// (#2611), like the ticks.
	const hasMonitorSamples = (report.monitor?.samples ?? 0) > 0;
	const {
		data: monitorData,
		isError: isMonitorError,
		error: monitorError,
		refetch: refetchMonitor,
	} = useRunMonitorSeriesQuery(runId ?? null, hasMonitorSamples, report.metadata?.status);

	const monitorFailure = useMemo<SeriesFailure | undefined>(() => {
		if (!isMonitorError) return undefined;
		return {
			message: monitorError?.message ?? "Vayu's engine returned no server-vitals data.",
			retry: () => void refetchMonitor(),
		};
	}, [isMonitorError, monitorError, refetchMonitor]);

	const monitorSamples = useMemo(() => monitorData?.data ?? [], [monitorData]);
	const monitorTicksPerBucket = monitorData?.bucketed ? monitorData.ticksPerBucket : undefined;

	/*
	 * The breakpoint and the anomaly windows are derived from the series the charts plot, whatever
	 * its shape (#2547). A run of at most HISTORY_SERIES_MAX_POINTS ticks arrives raw, one tick a
	 * second. A longer run arrives as buckets whose p99 is the worst second in each, so neither can
	 * miss a second over a threshold: the breakpoint lands on the bucket holding the first such
	 * second (its time the bucket's end, its concurrency the bucket's peak), and the 5xx onset on
	 * the bucket it appeared in. The detector's tick counts then count buckets (a 15-bucket
	 * baseline, two hot buckets for a window), so a shorter slowdown goes unnamed while the
	 * breakpoint still marks it; the chart section says so beside the charts.
	 */

	// The report alone can't supply the capacity breakpoint (it needs the per-tick
	// p99 series, now persisted per W1). Derive it from the time-series and fold it
	// into the dashboard bundle so the Saturation card / Breakpoint stat light up
	// for completed ramp_up runs instead of showing the "healthy"/"-" defaults.
	const settingSloMs = useClientSettingsStore((s) => s.sloThresholdMs);
	// A capacity run is judged against the budget its search stopped on, not the
	// Settings line, which may have moved since.
	const sloThresholdMs = report.capacity?.sloMs ?? settingSloMs;
	const derived = useMemo(() => {
		const base = reportToDerived(report);
		if (timeSeries.length < 2) return base;
		// The report has no per-tick concurrency, so the ramp's lag comes from the
		// stored series, by the same overlay the live view reads.
		const rampDeviationPct =
			base.mode === "ramp_up"
				? buildRampOverlay(timeSeries, {
						rampUpDurationSeconds: base.rampUpDurationSeconds,
						startConcurrency: base.startConcurrency,
						targetConcurrency: base.targetConcurrency,
					})?.rampDeviationPct
				: undefined;
		return {
			...base,
			breakpoint: computeBreakpoint(timeSeries, sloThresholdMs, runSloMs(report)),
			p99AtPeakMs: p99AtPeak(timeSeries),
			rampDeviationPct,
		};
	}, [report, timeSeries, sloThresholdMs]);

	// The run's degradation windows, from the series the charts plot, derived once and handed to
	// both tabs: Overview names them, Performance shades them.
	const anomalies = useMemo(() => detectAnomalies(timeSeries), [timeSeries]);

	// One line on whether the run's OAuth 2.0 credential was kept current - the
	// answer to 401s that appear partway through an otherwise healthy run.
	const authNote = useMemo(() => authRefreshNote(report.auth), [report.auth]);

	// Whether the run held its budgets (#2130) - null for a report that does not
	// say how the run ended, which draws nothing.
	const judgement = useMemo(() => reportOutcome(report), [report]);

	// Only a run of a saved request or a collection has "the same one" to compare
	// against. The run row is the cache the pane above already filled.
	const { data: run } = useRunQuery(runId || null);
	const identity = run ? runIdentity(run) : null;

	/*
	 * A "Compare with…" chosen on this run's History row (#2164) lands as a store intent, because
	 * `openTab` can only name the run, and the tab may already be open, so it cannot be a
	 * mount-time initial state. Taken once, so reopening the tab later opens on the report.
	 */
	const compareRequested = useTabsStore(
		(s) => s.navIntent?.kind === "compare" && s.navIntent.target === runId
	);
	const takeNavIntent = useTabsStore((s) => s.takeNavIntent);
	useEffect(() => {
		if (!compareRequested) return;
		if (!takeNavIntent("compare", runId)) return;
		// eslint-disable-next-line react-hooks/set-state-in-effect -- see above
		setComparing(true);
	}, [compareRequested, runId, takeNavIntent]);

	const openSample = ({ filter, number }: SampleDestination) => {
		setSampleFilter(filter);
		setSampleToExpand(number);
		setActiveTab("samples");
	};
	const selectTab = (next: string) => {
		setSampleToExpand(undefined);
		setActiveTab(next);
	};

	const revealDrawerView = useLayoutStore((state) => state.revealDrawerView);
	const crumbs = useMemo(
		() => [
			{ id: "history", label: "History", onSelect: () => revealDrawerView("history") },
			{ id: "run", label: `${RUN_TYPE_NAME.load} run` },
		],
		[revealDrawerView]
	);

	/*
	 * Everything the report says about the run before its tabs: the verdict, the target, the
	 * configuration, the baseline strip and the auth note. It scrolls with the body (above the tab
	 * panel or the comparison), so the fixed header stays one row plus the tab strip.
	 */
	const runContext = (
		<div className="flex flex-col gap-3">
			<RunOutcomeBanner judgement={judgement} />

			{/* Request Info Bar. A scenario load run has no single method or URL -
			    its target is a sequence - so it says what the sequence was instead
			    of claiming a "GET Unknown URL" that never existed. */}
			<div className="flex items-center gap-3 bg-muted/50 p-3">
				{isCollectionRun ? (
					<>
						<SequenceBadge />
						<TruncatedText className="text-sm text-foreground flex-1">
							{sequenceLabel}
						</TruncatedText>
					</>
				) : (
					<>
						<MethodBadge method={report.metadata?.requestMethod || "GET"} size="md" />
						<TruncatedText className="text-sm font-mono text-foreground flex-1">
							{report.metadata?.requestUrl || "Unknown URL"}
						</TruncatedText>
					</>
				)}
			</div>

			<RunConfigSummary
				config={report.metadata?.configuration}
				downgradedRequests={downgradedRequests}
				isCollectionRun={isCollectionRun}
			/>

			{/* How this run compares with the one pinned as its baseline.
			    Absent when nothing is pinned, or when this run is the pin -
			    see BaselineComparison. */}
			<BaselineComparison report={report} runId={runId} />

			{/* What kept the run authorized, only when the engine could refresh at all. */}
			{authNote && (
				<div
					className={`flex items-center gap-2 text-sm p-3 border rounded-md bg-background/50 ${
						authNote.warning ? "text-status-warning-text" : "text-muted-foreground"
					}`}
				>
					{authNote.warning ? (
						<AlertTriangle className="size-icon shrink-0" />
					) : (
						<KeyRound className="size-icon shrink-0" />
					)}
					<span>{authNote.text}</span>
				</div>
			)}
		</div>
	);

	return (
		<div className="flex flex-col h-full bg-background">
			{/* Fixed Header: where this run sits, and nothing else. */}
			<div className="border-b bg-card px-6 py-2">
				{/*
				 * Where this report sits (#1691): it opens from the History drawer, and "History"
				 * reveals that list rather than toggling it, so the crumb always shows the list it
				 * names. The run's own crumb is inert: you are on it, and its url and method are
				 * the bar at the top of the body.
				 */}
				<div className="flex items-center gap-2">
					<TabBreadcrumb
						label="Run location"
						crumbs={crumbs}
						titlesPane={titlesPane}
						className="min-w-0 flex-1 bg-transparent px-0 pt-0"
					/>
					{identity && (
						<Button
							variant="ghost"
							size="sm"
							className="h-control-sm shrink-0 gap-1.5 px-2 text-xs"
							onClick={() => setComparing(true)}
						>
							<GitCompareArrows className="size-icon-sm" aria-hidden="true" />
							Compare
						</Button>
					)}
				</div>
			</div>

			{/* Level 2 in both hosts: under this crumb on the dashboard, under the
			    run's header in History. */}
			<HeadingSection level={2}>
				{comparing && identity ? (
					<RunComparisonView
						report={report}
						runId={runId}
						identity={identity}
						onClose={() => setComparing(false)}
						runContext={runContext}
					/>
				) : (
					/* Tabbed Content */
					<Tabs
						value={tab}
						onValueChange={selectTab}
						className="flex-1 flex flex-col min-h-0"
					>
						<TabsList variant="inset" className="mx-4 mt-3">
							<TabsTrigger value="overview">
								<BarChart3 className="size-icon-sm" />
								<TabLabel>Overview</TabLabel>
							</TabsTrigger>
							<TabsTrigger value="performance">
								<TrendingUp className="size-icon-sm" />
								<TabLabel>Performance</TabLabel>
							</TabsTrigger>
							{/* Only for a run that has a sequence. A single-request load run
					    would get an empty tab, and the breakdown is the *only* place a
					    scenario load run says what each step did - it stores no
					    per-step results rows. */}
							{hasStepBreakdown && (
								<TabsTrigger value="steps">
									<ListOrdered className="size-icon-sm" />
									<TabLabel>Steps</TabLabel>
								</TabsTrigger>
							)}
							<TabsTrigger value="samples">
								<Activity className="size-icon-sm" />
								<TabLabel>Sampled requests</TabLabel>
							</TabsTrigger>
						</TabsList>

						<ScrollArea className="flex-1">
							<div className="@container flex flex-col gap-4 p-6">
								{runContext}
								<TabsContent value="overview" className="mt-0 space-y-4">
									<OverviewTab
										report={report}
										runId={runId}
										derived={derived}
										anomalies={anomalies}
										onOpenSample={openSample}
									/>
								</TabsContent>

								<TabsContent value="performance" className="mt-0 space-y-4">
									<PerformanceTab
										report={report}
										runId={runId}
										derived={derived}
										anomalies={anomalies}
										timeSeries={timeSeries}
										seriesFailure={seriesFailure}
										monitorSamples={monitorSamples}
										monitorFailure={monitorFailure}
										isLoadingSeries={isLoadingSeries}
										ticksPerBucket={ticksPerBucket}
										monitorTicksPerBucket={monitorTicksPerBucket}
										monitorSeries={run?.configSnapshot?.monitor?.series}
									/>
									{/* Not part of PerformanceTab: that is a view of this run's report
								    and renders without a QueryClient in tests; this reads the request's other runs. */}
									<RunTrend identity={identity} openRunId={runId} />
								</TabsContent>

								{hasStepBreakdown && (
									<TabsContent value="steps" className="mt-0 space-y-4">
										<ScenarioStepsTab
											steps={scenarioSteps}
											virtualUsers={report.scenario?.virtualUsers}
											iterations={report.scenario?.iterations}
											iterationsCompleted={
												report.scenario?.iterationsCompleted
											}
											iterationsAbandoned={
												report.scenario?.iterationsAbandoned
											}
											replayCard={testValidationTitleOf(report)}
										/>
									</TabsContent>
								)}

								<TabsContent value="samples" className="mt-0 space-y-4">
									<SamplesTab
										report={report}
										derived={derived}
										filter={sampleFilter}
										onFilterChange={setSampleFilter}
										initialExpandedNumber={sampleToExpand}
									/>
								</TabsContent>
							</div>
						</ScrollArea>
					</Tabs>
				)}
			</HeadingSection>
		</div>
	);
}
