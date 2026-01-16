/**
 * LoadTestDetail Component
 *
 * Displays details for a load test run with tabs for overview, performance, and samples.
 */

import { useState } from "react";
import { ArrowLeft, CheckCircle, Activity, Zap, TrendingUp, BarChart3 } from "lucide-react";
import {
	Button,
	Badge,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	ScrollArea,
} from "@/components/ui";
import { formatNumber } from "@/utils";
import { OverviewTab, PerformanceTab, SamplesTab } from "./components";
import type { LoadTestDetailProps } from "../types";

export default function LoadTestDetail({ report, onBack, runId }: LoadTestDetailProps) {
	const [activeTab, setActiveTab] = useState("overview");

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
				<div className="flex items-center gap-3 mb-3">
					<Button variant="ghost" size="icon" onClick={onBack} className="shrink-0">
						<ArrowLeft className="w-5 h-5" />
					</Button>
					<div className="flex-1 min-w-0">
						<h1 className="text-lg font-semibold text-foreground truncate">
							{report.metadata?.requestUrl || "Test Run Report"}
						</h1>
						<div className="flex items-center gap-2 mt-1">
							<span className="text-xs text-muted-foreground font-mono">{runId}</span>
							{report.metadata?.status && (
								<>
									<span className="text-xs text-muted-foreground">•</span>
									<Badge
										variant={
											report.metadata.status === "completed"
												? "default"
												: report.metadata.status === "failed"
													? "destructive"
													: "secondary"
										}
										className="text-xs capitalize"
									>
										{report.metadata.status}
									</Badge>
								</>
							)}
						</div>
					</div>
				</div>

				{/* Key Metrics Summary Row */}
				<div className="grid grid-cols-4 gap-3">
					<div className="bg-muted/50 rounded-lg p-3">
						<div className="flex items-center gap-2 mb-1">
							<Activity className="w-4 h-4 text-primary" />
							<span className="text-xs text-muted-foreground">Total Requests</span>
						</div>
						<p className="text-xl font-bold text-foreground">
							{formatNumber(report.summary.totalRequests)}
						</p>
					</div>
					<div className="bg-muted/50 rounded-lg p-3">
						<div className="flex items-center gap-2 mb-1">
							<CheckCircle className="w-4 h-4 text-green-500" />
							<span className="text-xs text-muted-foreground">Success Rate</span>
						</div>
						<p className="text-xl font-bold text-foreground">
							{successRate.toFixed(1)}%
						</p>
					</div>
					<div className="bg-muted/50 rounded-lg p-3">
						<div className="flex items-center gap-2 mb-1">
							<Zap className="w-4 h-4 text-blue-500" />
							<span className="text-xs text-muted-foreground">Avg RPS</span>
						</div>
						<p className="text-xl font-bold text-foreground">
							{formatNumber(report.summary.avgRps)}
						</p>
					</div>
					<div className="bg-muted/50 rounded-lg p-3">
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
							<PerformanceTab report={report} />
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
