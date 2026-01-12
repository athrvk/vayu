import { useState } from "react";
import { ArrowLeft, CheckCircle, XCircle, AlertCircle, Activity, Zap, TrendingUp, BarChart3 } from "lucide-react";
import { useAppStore } from "@/stores";
import { useRunReportQuery } from "@/queries";
import { formatNumber } from "@/utils";
import { Button, Card, CardContent, CardHeader, CardTitle, Badge, Tabs, TabsContent, TabsList, TabsTrigger, ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { RunReport } from "@/types";

export default function HistoryDetail() {
	const { selectedRunId, navigateToHistory } = useAppStore();
	const [activeTab, setActiveTab] = useState("overview");

	// Use TanStack Query for run report
	const {
		data: report,
		isLoading: loading,
		error: queryError,
	} = useRunReportQuery(selectedRunId);

	const error = queryError instanceof Error ? queryError.message : null;

	if (!selectedRunId) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground">
				<p>No run selected</p>
			</div>
		);
	}

	if (loading) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
			</div>
		);
	}

	if (error || !report) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center text-muted-foreground space-y-4">
				<AlertCircle className="w-12 h-12 text-destructive/50" />
				<p>{error || "Report not found"}</p>
				<Button onClick={navigateToHistory}>
					Back to History
				</Button>
			</div>
		);
	}

	const successRate = report.summary.totalRequests > 0
		? ((report.summary.totalRequests - report.summary.failedRequests) / report.summary.totalRequests) * 100
		: 0;

	return (
		<div className="flex flex-col h-full bg-background">
			{/* Fixed Header */}
			<div className="border-b bg-card px-6 py-4">
				<div className="flex items-center gap-3 mb-3">
					<Button
						variant="ghost"
						size="icon"
						onClick={navigateToHistory}
						className="shrink-0"
					>
						<ArrowLeft className="w-5 h-5" />
					</Button>
					<div className="flex-1 min-w-0">
						<h1 className="text-lg font-semibold text-foreground truncate">
							{report.metadata?.requestUrl || "Test Run Report"}
						</h1>
						<div className="flex items-center gap-2 mt-1">
							<span className="text-xs text-muted-foreground font-mono">{selectedRunId}</span>
							{report.metadata?.status && (
								<>
									<span className="text-xs text-muted-foreground">•</span>
									<Badge variant={
										report.metadata.status === 'completed' ? 'default' :
											report.metadata.status === 'failed' ? 'destructive' :
												'secondary'
									} className="text-xs capitalize">
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
						<p className="text-xl font-bold text-foreground">{formatNumber(report.summary.totalRequests)}</p>
					</div>
					<div className="bg-muted/50 rounded-lg p-3">
						<div className="flex items-center gap-2 mb-1">
							<CheckCircle className="w-4 h-4 text-green-500" />
							<span className="text-xs text-muted-foreground">Success Rate</span>
						</div>
						<p className="text-xl font-bold text-foreground">{successRate.toFixed(1)}%</p>
					</div>
					<div className="bg-muted/50 rounded-lg p-3">
						<div className="flex items-center gap-2 mb-1">
							<Zap className="w-4 h-4 text-blue-500" />
							<span className="text-xs text-muted-foreground">Avg RPS</span>
						</div>
						<p className="text-xl font-bold text-foreground">{formatNumber(report.summary.avgRps)}</p>
					</div>
					<div className="bg-muted/50 rounded-lg p-3">
						<div className="flex items-center gap-2 mb-1">
							<TrendingUp className="w-4 h-4 text-purple-500" />
							<span className="text-xs text-muted-foreground">P50 Latency</span>
						</div>
						<p className="text-xl font-bold text-foreground">{formatNumber(report.latency.p50)}ms</p>
					</div>
				</div>
			</div>

			{/* Tabbed Content */}
			<Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
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

// ============================================================================
// Overview Tab Component
// ============================================================================
function OverviewTab({ report }: { report: RunReport }) {
	return (
		<>
			{/* Test Configuration */}
			{report.metadata && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Test Configuration</CardTitle>
					</CardHeader>
					<CardContent>
						{report.metadata.configuration?.comment && (
							<div className="mb-4 p-3 bg-primary/5 border border-primary/20 rounded-lg">
								<p className="text-xs text-primary font-medium mb-1">Comment</p>
								<p className="text-sm text-foreground">{report.metadata.configuration.comment}</p>
							</div>
						)}
						<div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
							<div>
								<p className="text-xs text-muted-foreground mb-1">Request URL</p>
								<p className="text-sm font-medium text-foreground break-all">
									{report.metadata.requestUrl}
								</p>
							</div>
							<div>
								<p className="text-xs text-muted-foreground mb-1">Method</p>
								<Badge variant="outline" className="text-xs">
									{report.metadata.requestMethod}
								</Badge>
							</div>
							{report.metadata.configuration && (
								<>
									{report.metadata.configuration.mode && (
										<div>
											<p className="text-xs text-muted-foreground mb-1">Mode</p>
											<p className="text-sm font-medium text-foreground capitalize">
												{report.metadata.configuration.mode}
											</p>
										</div>
									)}
									{report.metadata.configuration.duration && (
										<div>
											<p className="text-xs text-muted-foreground mb-1">Configured Duration</p>
											<p className="text-sm font-medium text-foreground">
												{report.metadata.configuration.duration}
											</p>
										</div>
									)}
									{report.metadata.configuration.concurrency && (
										<div>
											<p className="text-xs text-muted-foreground mb-1">Concurrency</p>
											<p className="text-sm font-medium text-foreground">
												{report.metadata.configuration.concurrency} workers
											</p>
										</div>
									)}
								</>
							)}
							{report.summary.testDuration !== undefined && report.summary.testDuration > 0 && (
								<div>
									<p className="text-xs text-muted-foreground mb-1">Actual Duration</p>
									<p className="text-sm font-medium text-foreground">
										{report.summary.testDuration.toFixed(2)}s
										{report.summary.setupOverhead !== undefined && report.summary.setupOverhead > 0 && (
											<span className="text-xs text-muted-foreground ml-1">
												(+{(report.summary.setupOverhead * 1000).toFixed(0)}ms setup)
											</span>
										)}
									</p>
								</div>
							)}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Summary Statistics - More Compact */}
			<div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
				<MetricCard
					icon={<Activity className="w-5 h-5 text-primary" />}
					label="Total Requests"
					value={formatNumber(report.summary.totalRequests)}
				/>
				<MetricCard
					icon={<CheckCircle className="w-5 h-5 text-green-500" />}
					label="Successful"
					value={formatNumber(report.summary.totalRequests - report.summary.failedRequests)}
				/>
				<MetricCard
					icon={<XCircle className="w-5 h-5 text-destructive" />}
					label="Failed"
					value={formatNumber(report.summary.failedRequests)}
					className={report.summary.failedRequests > 0 ? "bg-destructive/5 border-destructive/20" : ""}
				/>
				<MetricCard
					icon={<Zap className="w-5 h-5 text-blue-500" />}
					label="Avg RPS"
					value={formatNumber(report.summary.avgRps)}
				/>
			</div>

			{/* Status Codes */}
			{report.statusCodes && Object.keys(report.statusCodes).length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Status Code Distribution</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
							{Object.entries(report.statusCodes).map(([code, count]) => {
								const isError = code === "0";
								const isSuccess = code.startsWith("2");
								const isRedirect = code.startsWith("3");
								const isClientError = code.startsWith("4");
								const isServerError = code.startsWith("5");

								return (
									<div
										key={code}
										className={cn(
											"p-3 rounded-lg border text-center",
											isError && "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900",
											isSuccess && "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-900",
											isRedirect && "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900",
											isClientError && "bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-900",
											isServerError && "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900",
											!isError && !isSuccess && !isRedirect && !isClientError && !isServerError && "bg-muted border-border"
										)}
									>
										<p className={cn(
											"text-lg font-bold font-mono mb-0.5",
											isError && "text-red-700 dark:text-red-400",
											isSuccess && "text-green-700 dark:text-green-400",
											isRedirect && "text-blue-700 dark:text-blue-400",
											isClientError && "text-yellow-700 dark:text-yellow-400",
											isServerError && "text-red-700 dark:text-red-400"
										)}>
											{isError ? "ERR" : code}
										</p>
										<p className="text-xs text-muted-foreground">
											{formatNumber(count)} reqs
										</p>
									</div>
								);
							})}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Errors */}
			{report.errors && report.errors.total > 0 && (
				<Card className="border-destructive/30">
					<CardHeader>
						<CardTitle className="text-base flex items-center gap-2 text-destructive">
							<AlertCircle className="w-5 h-5" />
							Error Summary
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<div className="flex justify-between items-center p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
							<span className="text-sm font-medium text-destructive">Total Errors</span>
							<span className="text-lg font-bold text-destructive">
								{formatNumber(report.errors.total)} ({report.summary.errorRate.toFixed(2)}%)
							</span>
						</div>

						{report.errors.types && Object.entries(report.errors.types).length > 0 && (
							<div className="space-y-2">
								<p className="text-xs font-medium text-muted-foreground">By Error Type</p>
								{Object.entries(report.errors.types).map(([errorType, count]) => (
									<div
										key={errorType}
										className="flex justify-between items-center p-2 bg-muted rounded text-sm"
									>
										<span className="capitalize">{errorType.replace(/_/g, ' ')}</span>
										<span className="font-medium">{formatNumber(count as number)}</span>
									</div>
								))}
							</div>
						)}

						{report.errors.byStatusCode && Object.entries(report.errors.byStatusCode).length > 0 && (
							<div className="space-y-2">
								<p className="text-xs font-medium text-muted-foreground">By Status Code</p>
								{Object.entries(report.errors.byStatusCode).map(([code, count]) => (
									<div
										key={code}
										className="flex justify-between items-center p-2 bg-muted rounded text-sm"
									>
										<span className="font-mono">
											{code === "0" ? "Network/Connection" : `HTTP ${code}`}
										</span>
										<span className="font-medium">{formatNumber(count as number)}</span>
									</div>
								))}
							</div>
						)}
					</CardContent>
				</Card>
			)}
		</>
	);
}

// ============================================================================
// Performance Tab Component
// ============================================================================
function PerformanceTab({ report }: { report: RunReport }) {
	return (
		<>
			{/* Latency Statistics */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Latency Distribution</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
						<LatencyMetric label="Average" value={report.latency.avg} />
						<LatencyMetric label="P50 (Median)" value={report.latency.p50} variant="primary" />
						{report.latency.p75 !== undefined && (
							<LatencyMetric label="P75" value={report.latency.p75} />
						)}
						<LatencyMetric label="P90" value={report.latency.p90} />
						<LatencyMetric label="P95" value={report.latency.p95} variant="warning" />
						<LatencyMetric label="P99" value={report.latency.p99} variant="danger" />
						{report.latency.p999 !== undefined && (
							<LatencyMetric label="P999" value={report.latency.p999} variant="danger" />
						)}
					</div>
				</CardContent>
			</Card>

			{/* Rate Control */}
			{report.rateControl && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Rate Control Performance</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-3 gap-6">
							<div className="text-center p-4 bg-muted/50 rounded-lg">
								<p className="text-xs text-muted-foreground mb-2">Target RPS</p>
								<p className="text-2xl font-bold text-foreground">
									{formatNumber(report.rateControl.targetRps)}
								</p>
							</div>
							<div className="text-center p-4 bg-muted/50 rounded-lg">
								<p className="text-xs text-muted-foreground mb-2">Actual RPS</p>
								<p className="text-2xl font-bold text-foreground">
									{formatNumber(report.rateControl.actualRps)}
								</p>
							</div>
							<div className="text-center p-4 bg-muted/50 rounded-lg">
								<p className="text-xs text-muted-foreground mb-2">Achievement Rate</p>
								<p className={cn(
									"text-2xl font-bold",
									report.rateControl.achievement >= 95 && report.rateControl.achievement <= 105
										? "text-green-600 dark:text-green-400"
										: report.rateControl.achievement >= 80 && report.rateControl.achievement <= 120
											? "text-yellow-600 dark:text-yellow-400"
											: "text-destructive"
								)}>
									{formatNumber(report.rateControl.achievement)}%
								</p>
							</div>
						</div>
					</CardContent>
				</Card>
			)}
		</>
	);
}

// ============================================================================
// Samples Tab Component
// ============================================================================
function SamplesTab({ report }: { report: RunReport }) {
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

	if (!report.results || report.results.length === 0) {
		return (
			<Card>
				<CardContent className="py-12 text-center">
					<Activity className="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" />
					<p className="text-sm text-muted-foreground">No sampled requests available</p>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle className="text-base">Sampled Request Details</CardTitle>
					<Badge variant="secondary" className="text-xs">
						{report.results.length} samples captured
					</Badge>
				</div>
			</CardHeader>
			<CardContent className="space-y-2">
				{report.results.map((sample, idx) => (
					<SampleRequestCard
						key={idx}
						sample={sample}
						index={idx}
						isExpanded={expandedIndex === idx}
						onToggle={() => setExpandedIndex(expandedIndex === idx ? null : idx)}
					/>
				))}
			</CardContent>
		</Card>
	);
}

// ============================================================================
// Helper Components
// ============================================================================
function MetricCard({ icon, label, value, className = "" }: {
	icon: React.ReactNode;
	label: string;
	value: string | number;
	className?: string;
}) {
	return (
		<Card className={className}>
			<CardContent className="pt-4">
				<div className="flex items-center gap-2 mb-2">
					{icon}
					<span className="text-xs text-muted-foreground">{label}</span>
				</div>
				<p className="text-xl font-bold text-foreground">{value}</p>
			</CardContent>
		</Card>
	);
}

function LatencyMetric({ label, value, variant = "default" }: {
	label: string;
	value: number;
	variant?: "default" | "primary" | "warning" | "danger";
}) {
	const colorClass = {
		default: "text-foreground",
		primary: "text-blue-600 dark:text-blue-400",
		warning: "text-orange-600 dark:text-orange-400",
		danger: "text-red-600 dark:text-red-400",
	}[variant];

	const bgClass = {
		default: "bg-muted/50",
		primary: "bg-blue-50 dark:bg-blue-950/30",
		warning: "bg-orange-50 dark:bg-orange-950/30",
		danger: "bg-red-50 dark:bg-red-950/30",
	}[variant];

	return (
		<div className={cn("p-3 rounded-lg text-center", bgClass)}>
			<p className="text-xs text-muted-foreground mb-1">{label}</p>
			<p className={cn("text-lg font-bold", colorClass)}>
				{formatNumber(value)}
				<span className="text-xs ml-0.5">ms</span>
			</p>
		</div>
	);
}

// Sample Request Card Component
function SampleRequestCard({ sample, index, isExpanded, onToggle }: {
	sample: any;
	index: number;
	isExpanded: boolean;
	onToggle: () => void;
}) {
	const formatTimestamp = (ts: string | number) => {
		const date = new Date(ts);
		return date.toLocaleString();
	};

	const isError = !!sample.error || sample.statusCode === 0;
	const isSuccess = sample.statusCode >= 200 && sample.statusCode < 300;

	return (
		<div className={cn(
			"border rounded-lg overflow-hidden transition-all",
			isError && "border-destructive/30",
			isSuccess && "border-green-500/20"
		)}>
			{/* Header - Always Visible */}
			<button
				onClick={onToggle}
				className="w-full flex items-center gap-3 p-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
			>
				<span className="text-xs font-mono text-muted-foreground w-8">#{index + 1}</span>

				{isError ? (
					<XCircle className="w-4 h-4 text-destructive shrink-0" />
				) : (
					<CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
				)}

				<Badge variant={isError ? "destructive" : isSuccess ? "default" : "outline"} className="font-mono text-xs">
					{sample.statusCode === 0 ? 'ERR' : sample.statusCode}
				</Badge>

				<span className="text-sm font-medium font-mono">{sample.latencyMs.toFixed(1)}ms</span>

				<span className="text-xs text-muted-foreground ml-auto">{formatTimestamp(sample.timestamp)}</span>

				<div className={cn(
					"w-2 h-2 rounded-full transition-transform",
					isExpanded && "rotate-180"
				)}>
					<div className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-muted-foreground" />
				</div>
			</button>

			{/* Expanded Details */}
			{isExpanded && (
				<div className="p-4 space-y-4 bg-card border-t">
					{/* Error Message */}
					{sample.error && (
						<div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
							<p className="text-xs font-medium text-destructive mb-1">Error</p>
							<p className="text-sm text-destructive font-mono break-all">{sample.error}</p>
						</div>
					)}

					{/* Timing Breakdown */}
					{sample.trace && (sample.trace.dnsMs !== undefined || sample.trace.connectMs !== undefined) && (
						<div>
							<h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase">Timing Breakdown</h4>
							<div className="grid grid-cols-5 gap-2">
								{sample.trace.dnsMs !== undefined && (
									<div className="bg-blue-50 dark:bg-blue-950/30 p-2 rounded text-center">
										<p className="text-[10px] text-muted-foreground">DNS</p>
										<p className="text-sm font-medium text-blue-700 dark:text-blue-300">{sample.trace.dnsMs.toFixed(1)}ms</p>
									</div>
								)}
								{sample.trace.connectMs !== undefined && (
									<div className="bg-purple-50 dark:bg-purple-950/30 p-2 rounded text-center">
										<p className="text-[10px] text-muted-foreground">Connect</p>
										<p className="text-sm font-medium text-purple-700 dark:text-purple-300">{sample.trace.connectMs.toFixed(1)}ms</p>
									</div>
								)}
								{sample.trace.tlsMs !== undefined && (
									<div className="bg-indigo-50 dark:bg-indigo-950/30 p-2 rounded text-center">
										<p className="text-[10px] text-muted-foreground">TLS</p>
										<p className="text-sm font-medium text-indigo-700 dark:text-indigo-300">{sample.trace.tlsMs.toFixed(1)}ms</p>
									</div>
								)}
								{sample.trace.firstByteMs !== undefined && (
									<div className="bg-green-50 dark:bg-green-950/30 p-2 rounded text-center">
										<p className="text-[10px] text-muted-foreground">TTFB</p>
										<p className="text-sm font-medium text-green-700 dark:text-green-300">{sample.trace.firstByteMs.toFixed(1)}ms</p>
									</div>
								)}
								{sample.trace.downloadMs !== undefined && (
									<div className="bg-yellow-50 dark:bg-yellow-950/30 p-2 rounded text-center">
										<p className="text-[10px] text-muted-foreground">Download</p>
										<p className="text-sm font-medium text-yellow-700 dark:text-yellow-300">{sample.trace.downloadMs.toFixed(1)}ms</p>
									</div>
								)}
							</div>
						</div>
					)}

					{/* Additional trace data if available */}
					{sample.trace?.requestHeaders && (
						<div>
							<h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase">Request Headers</h4>
							<pre className="bg-muted p-3 rounded text-xs overflow-x-auto max-h-40">
								{sample.trace.requestHeaders}
							</pre>
						</div>
					)}

					{sample.trace?.responseHeaders && (
						<div>
							<h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase">Response Headers</h4>
							<pre className="bg-muted p-3 rounded text-xs overflow-x-auto max-h-40">
								{sample.trace.responseHeaders}
							</pre>
						</div>
					)}

					{sample.trace?.responseBody && (
						<div>
							<h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase">Response Body</h4>
							<pre className="bg-muted p-3 rounded text-xs overflow-x-auto max-h-60">
								{sample.trace.responseBody}
							</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

