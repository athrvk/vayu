
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

import { useState } from "react";
import { CheckCircle, Activity, Zap, TrendingUp, BarChart3, Settings2 } from "lucide-react";
import {
	Badge,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	ScrollArea,
} from "@/components/ui";
import { formatNumber, loadTestTypeToLabel } from "@/utils";
import type { LoadTestConfig } from "@/types";
import { OverviewTab, PerformanceTab, SamplesTab } from "./components";
import type { LoadTestDetailProps } from "../types";

export default function LoadTestDetail({ report, onBack: _onBack, runId }: LoadTestDetailProps) {
	const [activeTab, setActiveTab] = useState("overview");
	const config = report.metadata?.configuration;

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
								<span className="text-foreground font-mono">{String(config.duration)}</span>
							</div>
						)}
						{config.targetRps != null && config.targetRps > 0 && (
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground">Target RPS:</span>
								<span className="text-foreground font-mono">{config.targetRps}</span>
							</div>
						)}
						{config.concurrency != null && config.concurrency > 0 && (
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground">Concurrency:</span>
								<span className="text-foreground font-mono">{config.concurrency}</span>
							</div>
						)}
						{config.timeout != null && config.timeout > 0 && (
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground">Timeout:</span>
								<span className="text-foreground font-mono">{config.timeout}ms</span>
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

				{/* Key Metrics Summary Row */}
				<div className="grid grid-cols-4 gap-3">
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
					<div className="bg-muted/50 p-3">
						<div className="flex items-center gap-2 mb-1">
							<Zap className="w-4 h-4 text-blue-500" />
							<span className="text-xs text-muted-foreground">Avg RPS</span>
						</div>
						<p className="text-xl font-bold text-foreground">
							{formatNumber(report.summary.avgRps)}
						</p>
					</div>
					<div className="bg-muted/50 p-3">
						<div className="flex items-center gap-2 mb-1">
							<TrendingUp className="w-4 h-4 text-purple-500" />
							<span className="text-xs text-muted-foreground">P50 Latency</span>
						</div>
						<p className="text-xl font-bold text-foreground">
							{formatNumber(report.latency.p50)}ms
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
							<OverviewTab report={report} />
						</TabsContent>

						<TabsContent value="performance" className="mt-0 space-y-4">
							<PerformanceTab report={report} runId={runId} />
						</TabsContent>

						<TabsContent value="samples" className="mt-0 space-y-4">
							<SamplesTab report={report} />
						</TabsContent>
					</div>
				</ScrollArea>
			</Tabs>
		</div>
	);
}
