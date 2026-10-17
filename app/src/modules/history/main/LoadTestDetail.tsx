/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * LoadTestDetail Component
 *
 * Displays details for a load test run with tabs for overview, performance, and samples.
 */

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
	Badge,
	Button,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	TabLabel,
	ScrollArea,
} from "@/components/ui";
import { formatNumber } from "@/lib/format-number";
import { formatConcurrency } from "@/constants/load-test-modes";
import {
	MethodBadge,
	RunOutcomeBanner,
	TabBreadcrumb,
	TruncatedText,
	reportOutcome,
} from "@/components/shared";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import { computeBreakpoint } from "@/modules/dashboard/utils/computeBreakpoint";
import { pluralize } from "@/modules/dashboard/utils/format";
import { detectAnomalies } from "@/modules/dashboard/utils/detectAnomalies";
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
import type {
	LoadTestDetailProps,
	MonitorSeriesResponse,
	SeriesFailure,
	TimeSeriesResponse,
} from "../types";

export default function LoadTestDetail({ report, runId }: LoadTestDetailProps) {
	const [activeTab, setActiveTab] = useState("overview");
	// Held here, not in SamplesTab: Radix unmounts an inactive panel, so the tab
	// would forget a chip or an open row the moment another tab was chosen. The
	// open row is a one-shot (#2213) - a tab the user picks drops it, so going
	// back to Samples does not re-open what an Overview row once pointed at.
	const [sampleFilter, setSampleFilter] = useState<SampleFilter>("all");
	const [sampleToExpand, setSampleToExpand] = useState<number>();
	const [comparing, setComparing] = useState(false);
	// What actually happened, beside the protocol the run asked for. A 0 covers
	// both "no request was downgraded" and "this run predates the count" - the
	// engine does not distinguish them (see the field's doc in types/domain.ts),
	// and neither should draw a warning, so `undefined` folding into 0 loses
	// nothing.
	const downgradedRequests = report.summary.httpVersionDowngraded ?? 0;

	/*
	 * A scenario load run: `type: "load"` (it publishes ticks and reports
	 * percentiles like any load run), but its target is a sequence, so it has no
	 * single method or URL and reports its per-step numbers as a breakdown
	 * rather than as `results[]` rows.
	 *
	 * Detected by the breakdown's presence rather than by a run-type flag,
	 * because that is what this pane actually needs to render: a report without
	 * one has nothing to put in the tab, whatever the run called itself.
	 */
	const scenarioSteps = report.scenario?.steps;
	const isScenarioLoad = !!scenarioSteps?.length;
	// A selection the rendered tabs no longer include (Steps, when the report
	// changes to a single-request run) would match no panel and leave the pane blank.
	const availableTabs = new Set(["overview", "performance", "samples"]);
	if (isScenarioLoad) availableTabs.add("steps");
	const tab = availableTabs.has(activeTab) ? activeTab : "overview";
	// `TruncatedText` measures one string, so the sentence is built rather than
	// composed out of nodes it would have to flatten.
	const virtualUsers = report.scenario?.virtualUsers;
	const sequenceLabel = isScenarioLoad
		? `${formatNumber(scenarioSteps.length)} ${pluralize(scenarioSteps.length, "step")} per iteration` +
			(virtualUsers === undefined ? "" : ` - ${formatConcurrency(virtualUsers)}`)
		: "";

	// Fetch the persisted per-tick time-series once, here, so both the Overview
	// stat cards (breakpoint / saturation, derived below) and the Performance tab
	// charts read the same data - one query, shared cache.
	const {
		data: timeSeriesData,
		isLoading: isLoadingSeries,
		isError: isSeriesError,
		error: seriesError,
		isFetchingNextPage,
		hasNextPage,
		fetchNextPage,
		refetch: refetchSeries,
	} = useRunTimeSeriesQuery(runId ?? null, report.metadata?.status);

	// Auto-page through the full series so breakpoint detection and the charts see
	// every tick, not just the first page. Not while the query is in error: a
	// failed page leaves `hasNextPage` true and `isFetchingNextPage` back at
	// false, which is exactly this effect's trigger, so it would re-request the
	// failing page in a tight loop. The failure's Retry calls `fetchNextPage`
	// itself, and a success clears the error and resumes the paging.
	useEffect(() => {
		if (hasNextPage && !isFetchingNextPage && !isSeriesError) {
			fetchNextPage();
		}
	}, [hasNextPage, isFetchingNextPage, isSeriesError, fetchNextPage]);

	// A partly loaded series resumes at the page that failed; one with nothing
	// loaded starts over. `refetch` would re-read every loaded page instead.
	const seriesFailure = useMemo<SeriesFailure | undefined>(() => {
		if (!isSeriesError) return undefined;
		const resumable = hasNextPage && !!timeSeriesData?.pages?.length;
		return {
			message: seriesError?.message ?? "The engine returned no time-series data.",
			retry: () => void (resumable ? fetchNextPage() : refetchSeries()),
		};
	}, [isSeriesError, seriesError, hasNextPage, timeSeriesData, fetchNextPage, refetchSeries]);

	const timeSeries = useMemo(
		() => timeSeriesData?.pages?.flatMap((page: TimeSeriesResponse) => page.data) ?? [],
		[timeSeriesData]
	);

	// Server vitals, only for a run that actually recorded some: the report's
	// `monitor` section is the run's own record of what the scrape did, so a run
	// that monitored nothing (or whose every scrape failed) never issues the
	// fetch at all.
	const hasMonitorSamples = (report.monitor?.samples ?? 0) > 0;
	const {
		data: monitorData,
		isError: isMonitorError,
		error: monitorError,
		isFetchingNextPage: isFetchingMonitorPage,
		hasNextPage: hasMoreMonitor,
		fetchNextPage: fetchMoreMonitor,
		refetch: refetchMonitor,
	} = useRunMonitorSeriesQuery(runId ?? null, hasMonitorSamples, report.metadata?.status);

	// Held back while in error for the reason the time series' effect is (#2062).
	useEffect(() => {
		if (hasMoreMonitor && !isFetchingMonitorPage && !isMonitorError) {
			fetchMoreMonitor();
		}
	}, [hasMoreMonitor, isFetchingMonitorPage, isMonitorError, fetchMoreMonitor]);

	const monitorFailure = useMemo<SeriesFailure | undefined>(() => {
		if (!isMonitorError) return undefined;
		const resumable = hasMoreMonitor && !!monitorData?.pages?.length;
		return {
			message: monitorError?.message ?? "The engine returned no server-vitals data.",
			retry: () => void (resumable ? fetchMoreMonitor() : refetchMonitor()),
		};
	}, [
		isMonitorError,
		monitorError,
		hasMoreMonitor,
		monitorData,
		fetchMoreMonitor,
		refetchMonitor,
	]);

	const monitorSamples = useMemo(
		() => monitorData?.pages?.flatMap((page: MonitorSeriesResponse) => page.data) ?? [],
		[monitorData]
	);

	const seriesProgress = useMemo(() => {
		if (!timeSeriesData?.pages?.length) return undefined;
		const lastPage = timeSeriesData.pages[timeSeriesData.pages.length - 1];
		return { loaded: timeSeries.length, total: lastPage.pagination.total };
	}, [timeSeriesData, timeSeries]);

	// The report alone can't supply the capacity breakpoint (it needs the per-tick
	// p99 series, now persisted per W1). Derive it from the time-series and fold it
	// into the dashboard bundle so the Saturation card / Breakpoint stat light up
	// for completed ramp_up runs instead of showing the "healthy"/"-" defaults.
	const sloThresholdMs = useClientSettingsStore((s) => s.sloThresholdMs);
	const derived = useMemo(() => {
		const base = reportToDerived(report);
		if (timeSeries.length < 2) return base;
		return { ...base, breakpoint: computeBreakpoint(timeSeries, sloThresholdMs) };
	}, [report, timeSeries, sloThresholdMs]);

	// The run's degradation windows, from the same series the charts plot. Derived
	// once here and handed to both tabs: Overview names them, Performance shades
	// them, and neither re-derives.
	const anomalies = useMemo(() => detectAnomalies(timeSeries), [timeSeries]);

	// One line on whether the run's OAuth 2.0 credential was kept current - the
	// answer to 401s that appear partway through an otherwise healthy run.
	const authNote = useMemo(() => authRefreshNote(report.auth), [report.auth]);

	// Whether the run held its budgets (#2130) - null for a report that does not
	// say how the run ended, which draws nothing.
	const judgement = useMemo(() => reportOutcome(report), [report]);

	// Only a run of a saved request has "the same request" to compare against.
	// The run row is the cache the pane above already filled.
	const { data: run } = useRunQuery(runId || null);
	const compareRequestId = run?.requestId ?? null;

	/*
	 * A "Compare with..." chosen on this run's History row (#2164) lands here as
	 * a store target, because `openTab` can only name the run. Handed over once
	 * and cleared, so reopening the tab later opens on the report. The tab may
	 * already be open, so this cannot be a mount-time initial state.
	 */
	const compareRequested = useTabsStore((s) => s.compareRunTarget === runId);
	const clearCompareRunTarget = useTabsStore((s) => s.clearCompareRunTarget);
	useEffect(() => {
		if (!compareRequested) return;
		// eslint-disable-next-line react-hooks/set-state-in-effect -- see above
		setComparing(true);
		clearCompareRunTarget();
	}, [compareRequested, clearCompareRunTarget]);

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
			{ id: "run", label: isScenarioLoad ? "Scenario load run" : "Load test run" },
		],
		[isScenarioLoad, revealDrawerView]
	);

	/*
	 * Everything the report says about the run before its tabs: the verdict, the
	 * target, the configuration, the baseline strip and the auth note. It scrolls
	 * with the body (above the tab panel, or above the comparison) so the fixed
	 * header stays at one row plus the tab strip.
	 */
	const runContext = (
		<div className="flex flex-col gap-3">
			<RunOutcomeBanner judgement={judgement} />

			{/* Request Info Bar. A scenario load run has no single method or URL -
			    its target is a sequence - so it says what the sequence was instead
			    of claiming a "GET Unknown URL" that never existed. */}
			<div className="flex items-center gap-3 bg-muted/50 p-3">
				{isScenarioLoad ? (
					<>
						{/* Not a `MethodBadge`: SEQUENCE is not a method, and the
						    primitive would tint it in the OPTIONS colour (the
						    `getMethodColor` fallback) and truncate it at the
						    seven-character method column. It keeps the neutral
						    outline chip, minus a `font-bold` the code font has no
						    face for - `Badge`'s own `font-semibold` is the weight
						    the mono step documents (#1199). */}
						<Badge variant="outline" className="font-mono shrink-0">
							SEQUENCE
						</Badge>
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
			/>

			{/* How this run compares with the one pinned as its baseline.
			    Absent when nothing is pinned, or when this run is the pin -
			    see BaselineComparison. */}
			<BaselineComparison report={report} runId={runId} />

			{/* What kept the run authorized. Drawn only when the engine was able to
			    refresh at all - a run without the section reports nothing here,
			    exactly as every run did before mid-run refresh existed. */}
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
				 * Where this report sits (#1691). A run report opens from the History
				 * drawer and said nothing about where it came from; "History" reveals
				 * that list rather than toggling it, so the crumb always shows the
				 * list it names. The run's own crumb is inert - you are already on it,
				 * and its url and method are the bar at the top of the body.
				 */}
				<div className="flex items-center gap-2">
					<TabBreadcrumb
						label="Run location"
						crumbs={crumbs}
						className="min-w-0 flex-1 bg-transparent px-0 pt-0"
					/>
					{compareRequestId && (
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

			{comparing && compareRequestId ? (
				<RunComparisonView
					report={report}
					runId={runId}
					requestId={compareRequestId}
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
						{isScenarioLoad && (
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
						<div className="flex flex-col gap-4 p-6">
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
									isFetchingMore={isFetchingNextPage}
									progress={seriesProgress}
								/>
								{/* Not part of PerformanceTab: that is a view of this run's report
								    and renders without a QueryClient in tests; this reads the request's other runs. */}
								<RunTrend requestId={compareRequestId} openRunId={runId} />
							</TabsContent>

							{isScenarioLoad && (
								<TabsContent value="steps" className="mt-0 space-y-4">
									<ScenarioStepsTab
										steps={scenarioSteps}
										virtualUsers={report.scenario?.virtualUsers}
										iterationsCompleted={report.scenario?.iterationsCompleted}
										iterationsAbandoned={report.scenario?.iterationsAbandoned}
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
		</div>
	);
}
