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
	CheckCircle,
	Activity,
	TrendingUp,
	BarChart3,
	Settings2,
	AlertTriangle,
	ListOrdered,
	KeyRound,
} from "lucide-react";
import {
	Badge,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	TabLabel,
	ScrollArea,
} from "@/components/ui";
import { formatNumber, loadTestTypeToLabel } from "@/utils";
import { TruncatedText } from "@/components/shared";
import { HTTP_VERSIONS, isHttpVersion } from "@/constants/request";
import type { LoadTestConfig } from "@/types";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import { computeBreakpoint } from "@/modules/dashboard/utils/computeBreakpoint";
import { detectAnomalies } from "@/modules/dashboard/utils/detectAnomalies";
import { useRunMonitorSeriesQuery, useRunTimeSeriesQuery } from "@/queries/runs";
import { useClientSettingsStore } from "@/stores";
import { OverviewTab, PerformanceTab, SamplesTab, ScenarioStepsTab } from "./components";
import { authRefreshNote } from "./auth-refresh-note";
import type { LoadTestDetailProps, MonitorSeriesResponse, TimeSeriesResponse } from "../types";

export default function LoadTestDetail({ report, runId }: LoadTestDetailProps) {
	const [activeTab, setActiveTab] = useState("overview");
	const config = report.metadata?.configuration;
	// Requested protocol, not the negotiated one (`RunResultTrace.response.httpVersion`
	// is per-exchange and has no single value across a load run's many requests).
	// Labelled from the shared HTTP_VERSIONS list so this never keeps its own copy.
	const requestedHttpVersion = config?.httpVersion;
	const protocolLabel = isHttpVersion(requestedHttpVersion)
		? HTTP_VERSIONS.find((v) => v.value === requestedHttpVersion)?.label
		: undefined;
	// What actually happened, beside what was asked for. A 0 covers both "no
	// request was downgraded" and "this run predates the count" - the engine does
	// not distinguish them (see the field's doc in types/domain.ts), and neither
	// should draw a warning, so `undefined` folding into 0 loses nothing.
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
	// `TruncatedText` measures one string, so the sentence is built rather than
	// composed out of nodes it would have to flatten.
	const virtualUsers = report.scenario?.virtualUsers;
	const sequenceLabel = isScenarioLoad
		? `${scenarioSteps.length} step${scenarioSteps.length === 1 ? "" : "s"} per iteration` +
			(virtualUsers === undefined
				? ""
				: ` - ${virtualUsers} virtual user${virtualUsers === 1 ? "" : "s"}`)
		: "";

	// Fetch the persisted per-tick time-series once, here, so both the Overview
	// stat cards (breakpoint / saturation, derived below) and the Performance tab
	// charts read the same data - one query, shared cache.
	const {
		data: timeSeriesData,
		isLoading: isLoadingSeries,
		isFetchingNextPage,
		hasNextPage,
		fetchNextPage,
	} = useRunTimeSeriesQuery(runId ?? null);

	// Auto-page through the full series so breakpoint detection and the charts see
	// every tick, not just the first page.
	useEffect(() => {
		if (hasNextPage && !isFetchingNextPage) {
			fetchNextPage();
		}
	}, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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
		isFetchingNextPage: isFetchingMonitorPage,
		hasNextPage: hasMoreMonitor,
		fetchNextPage: fetchMoreMonitor,
	} = useRunMonitorSeriesQuery(runId ?? null, hasMonitorSamples);

	useEffect(() => {
		if (hasMoreMonitor && !isFetchingMonitorPage) {
			fetchMoreMonitor();
		}
	}, [hasMoreMonitor, isFetchingMonitorPage, fetchMoreMonitor]);

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

	const successRate =
		report.summary.totalRequests > 0
			? ((report.summary.totalRequests - report.summary.failedRequests) /
					report.summary.totalRequests) *
				100
			: 0;

	return (
		<div className="flex flex-col h-full bg-background">
			{/* Fixed Header */}
			<div className="border-b bg-card px-6 py-4">
				{/* Request Info Bar. A scenario load run has no single method or URL -
				    its target is a sequence - so it says what the sequence was instead
				    of claiming a "GET Unknown URL" that never existed. */}
				<div className="flex items-center gap-3 bg-muted/50 p-3 mb-3">
					{isScenarioLoad ? (
						<>
							<Badge variant="outline" className="font-mono font-bold shrink-0">
								SEQUENCE
							</Badge>
							<TruncatedText className="text-sm text-foreground flex-1">
								{sequenceLabel}
							</TruncatedText>
						</>
					) : (
						<>
							<Badge variant="outline" className="font-mono font-bold shrink-0">
								{report.metadata?.requestMethod || "GET"}
							</Badge>
							<TruncatedText className="text-sm font-mono text-foreground flex-1">
								{report.metadata?.requestUrl || "Unknown URL"}
							</TruncatedText>
						</>
					)}
				</div>

				{/* Load test config used for this run. Gated on protocolLabel too, not
				    just mode/comment - POST /runs accepts an iterations-only body with
				    no `mode` key (execution.cpp only requires mode+duration OR
				    iterations), so a run can legitimately have neither and still carry
				    a protocol worth showing. */}
				{config && (config.mode || config.comment || protocolLabel) && (
					<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm mb-3 p-3 border rounded-md bg-background/50">
						<div className="flex items-center gap-2 text-muted-foreground">
							<Settings2 className="w-4 h-4 shrink-0" />
							<span className="font-medium">Test config</span>
						</div>
						{config.mode && (
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground">Mode:</span>
								<span className="text-foreground capitalize">
									{loadTestTypeToLabel(config.mode as LoadTestConfig["mode"])}
								</span>
							</div>
						)}
						{protocolLabel && (
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground">Protocol:</span>
								<span className="text-foreground font-mono">{protocolLabel}</span>
								{/* The label above is what the run *asked for*, and on its own
								    it is the mislabelling issue #215 describes: a run whose
								    every request fell back to HTTP/1.1 still reads "HTTP/2"
								    here, over latency and throughput measured on HTTP/1.1.
								    This is the correction, drawn only when the engine counted
								    a downgrade - see summary.httpVersionDowngraded. */}
								{downgradedRequests > 0 && (
									<span
										className="flex items-center gap-1.5 text-status-warning-text"
										title={
											`${formatNumber(downgradedRequests)} of this run's requests asked for ` +
											`HTTP/2 and negotiated an older protocol.\n` +
											`The results below were measured over those connections.`
										}
									>
										<AlertTriangle className="w-4 h-4 shrink-0" />
										not negotiated
									</span>
								)}
							</div>
						)}
						{config.duration != null && config.duration !== "" && (
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground">Duration:</span>
								<span className="text-foreground font-mono">
									{String(config.duration)}
								</span>
							</div>
						)}
						{config.targetRps != null && config.targetRps > 0 && (
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground">Target RPS:</span>
								<span className="text-foreground font-mono">
									{config.targetRps}
								</span>
							</div>
						)}
						{config.concurrency != null && config.concurrency > 0 && (
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground">Concurrency:</span>
								<span className="text-foreground font-mono">
									{config.concurrency}
								</span>
							</div>
						)}
						{config.timeout != null && config.timeout > 0 && (
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground">Timeout:</span>
								<span className="text-foreground font-mono">
									{config.timeout}ms
								</span>
							</div>
						)}
						{config.comment && (
							<div className="w-full mt-1 pt-2 border-t border-border/50">
								<span className="text-muted-foreground">Note: </span>
								<span className="text-foreground/90 italic">{config.comment}</span>
							</div>
						)}
					</div>
				)}

				{/* What kept the run authorized. Drawn only when the engine was able to
				    refresh at all - a run without the section reports nothing here,
				    exactly as every run did before mid-run refresh existed. */}
				{authNote && (
					<div
						className={`flex items-center gap-2 text-sm mb-3 p-3 border rounded-md bg-background/50 ${
							authNote.warning ? "text-status-warning-text" : "text-muted-foreground"
						}`}
					>
						{authNote.warning ? (
							<AlertTriangle className="w-4 h-4 shrink-0" />
						) : (
							<KeyRound className="w-4 h-4 shrink-0" />
						)}
						<span>{authNote.text}</span>
					</div>
				)}

				{/* Key metrics - p99-led, compact glance (stays visible across tabs) */}
				<div className="grid grid-cols-3 gap-3">
					<div className="bg-muted/50 p-3">
						<div className="flex items-center gap-2 mb-1">
							{/* Raw palette, and staying. Measured 3.50 light / 3.66 dark on
						    this tile against the 3.0 icon bar - it clears it in both
						    themes, and there is no violet semantic token to move it to. */}
							<TrendingUp className="w-4 h-4 text-purple-500" />
							<span className="text-xs text-muted-foreground">P99 Latency</span>
						</div>
						<p className="text-xl font-bold text-foreground">
							{formatNumber(report.latency.p99)}ms
						</p>
					</div>
					<div className="bg-muted/50 p-3">
						<div className="flex items-center gap-2 mb-1">
							<Activity className="w-4 h-4 text-primary" />
							<span className="text-xs text-muted-foreground">Total Requests</span>
						</div>
						<p className="text-xl font-bold text-foreground">
							{formatNumber(report.summary.totalRequests)}
						</p>
					</div>
					<div className="bg-muted/50 p-3">
						<div className="flex items-center gap-2 mb-1">
							<CheckCircle className="w-4 h-4 text-status-success-text" />
							<span className="text-xs text-muted-foreground">Success Rate</span>
						</div>
						<p className="text-xl font-bold text-foreground">
							{successRate.toFixed(1)}%
						</p>
					</div>
				</div>
			</div>

			{/* Tabbed Content */}
			<Tabs
				value={activeTab}
				onValueChange={setActiveTab}
				className="flex-1 flex flex-col min-h-0"
			>
				<TabsList className="mx-5 mt-3">
					<TabsTrigger value="overview">
						<BarChart3 className="w-3.5 h-3.5" />
						<TabLabel>Overview</TabLabel>
					</TabsTrigger>
					<TabsTrigger value="performance">
						<TrendingUp className="w-3.5 h-3.5" />
						<TabLabel>Performance</TabLabel>
					</TabsTrigger>
					{/* Only for a run that has a sequence. A single-request load run
					    would get an empty tab, and the breakdown is the *only* place a
					    scenario load run says what each step did - it stores no
					    per-step results rows. */}
					{isScenarioLoad && (
						<TabsTrigger value="steps">
							<ListOrdered className="w-3.5 h-3.5" />
							<TabLabel>Steps</TabLabel>
						</TabsTrigger>
					)}
					<TabsTrigger value="samples">
						<Activity className="w-3.5 h-3.5" />
						<TabLabel>Sampled Requests</TabLabel>
					</TabsTrigger>
				</TabsList>

				<ScrollArea className="flex-1">
					<div className="p-6">
						<TabsContent value="overview" className="mt-0 space-y-4">
							<OverviewTab report={report} derived={derived} anomalies={anomalies} />
						</TabsContent>

						<TabsContent value="performance" className="mt-0 space-y-4">
							<PerformanceTab
								report={report}
								runId={runId}
								derived={derived}
								anomalies={anomalies}
								timeSeries={timeSeries}
								monitorSamples={monitorSamples}
								isLoadingSeries={isLoadingSeries}
								isFetchingMore={isFetchingNextPage}
								progress={seriesProgress}
							/>
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
							<SamplesTab report={report} derived={derived} />
						</TabsContent>
					</div>
				</ScrollArea>
			</Tabs>
		</div>
	);
}
