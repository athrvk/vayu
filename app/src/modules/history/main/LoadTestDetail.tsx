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
import { CheckCircle, Activity, TrendingUp, BarChart3, Settings2 } from "lucide-react";
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger, ScrollArea } from "@/components/ui";
import { formatNumber, loadTestTypeToLabel } from "@/utils";
import type { LoadTestConfig } from "@/types";
import { reportToDerived } from "@/modules/dashboard/utils/reportToDerived";
import { computeBreakpoint } from "@/modules/dashboard/utils/computeBreakpoint";
import { useRunTimeSeriesQuery } from "@/queries/runs";
import { useClientSettingsStore } from "@/stores";
import { OverviewTab, PerformanceTab, SamplesTab } from "./components";
import type { LoadTestDetailProps, TimeSeriesResponse } from "../types";

export default function LoadTestDetail({ report, onBack: _onBack, runId }: LoadTestDetailProps) {
	const [activeTab, setActiveTab] = useState("overview");
	const config = report.metadata?.configuration;

	// Fetch the persisted per-tick time-series once, here, so both the Overview
	// stat cards (breakpoint / saturation, derived below) and the Performance tab
	// charts read the same data — one query, shared cache.
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

	const seriesProgress = useMemo(() => {
		if (!timeSeriesData?.pages?.length) return undefined;
		const lastPage = timeSeriesData.pages[timeSeriesData.pages.length - 1];
		return { loaded: timeSeries.length, total: lastPage.pagination.total };
	}, [timeSeriesData, timeSeries]);

	// The report alone can't supply the capacity breakpoint (it needs the per-tick
	// p99 series, now persisted per W1). Derive it from the time-series and fold it
	// into the dashboard bundle so the Saturation card / Breakpoint stat light up
	// for completed ramp_up runs instead of showing the "healthy"/"—" defaults.
	const sloThresholdMs = useClientSettingsStore((s) => s.sloThresholdMs);
	const derived = useMemo(() => {
		const base = reportToDerived(report);
		if (timeSeries.length < 2) return base;
		return { ...base, breakpoint: computeBreakpoint(timeSeries, sloThresholdMs) };
	}, [report, timeSeries, sloThresholdMs]);

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
				{/* Request Info Bar */}
				<div className="flex items-center gap-3 bg-muted/50 p-3 mb-3">
					<Badge variant="outline" className="font-mono font-bold shrink-0">
						{report.metadata?.requestMethod || "GET"}
					</Badge>
					<span className="text-sm font-mono text-foreground truncate flex-1">
						{report.metadata?.requestUrl || "Unknown URL"}
					</span>
				</div>

				{/* Load test config used for this run */}
				{(config?.mode || config?.comment) && (
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

				{/* Key metrics — p99-led, compact glance (stays visible across tabs) */}
				<div className="grid grid-cols-3 gap-3">
					<div className="bg-muted/50 p-3">
						<div className="flex items-center gap-2 mb-1">
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
							<CheckCircle className="w-4 h-4 text-green-500" />
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
				<TabsList className="mx-6 mt-4">
					<TabsTrigger value="overview" className="text-xs">
						<BarChart3 className="w-3.5 h-3.5 mr-1.5" />
						Overview
					</TabsTrigger>
					<TabsTrigger value="performance" className="text-xs">
						<TrendingUp className="w-3.5 h-3.5 mr-1.5" />
						Performance
					</TabsTrigger>
					<TabsTrigger value="samples" className="text-xs">
						<Activity className="w-3.5 h-3.5 mr-1.5" />
						Sampled Requests
					</TabsTrigger>
				</TabsList>

				<ScrollArea className="flex-1">
					<div className="p-6">
						<TabsContent value="overview" className="mt-0 space-y-4">
							<OverviewTab report={report} derived={derived} />
						</TabsContent>

						<TabsContent value="performance" className="mt-0 space-y-4">
							<PerformanceTab
								report={report}
								runId={runId}
								derived={derived}
								timeSeries={timeSeries}
								isLoadingSeries={isLoadingSeries}
								isFetchingMore={isFetchingNextPage}
								progress={seriesProgress}
							/>
						</TabsContent>

						<TabsContent value="samples" className="mt-0 space-y-4">
							<SamplesTab report={report} derived={derived} />
						</TabsContent>
					</div>
				</ScrollArea>
			</Tabs>
		</div>
	);
}
