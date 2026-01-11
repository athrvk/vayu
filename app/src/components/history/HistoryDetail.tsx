import { useState } from "react";
import { ArrowLeft, Clock, CheckCircle, XCircle, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { useAppStore } from "@/stores";
import { useRunReportQuery } from "@/queries";
import { formatNumber } from "@/utils";
import { Button, Card, CardContent, CardHeader, CardTitle, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";

export default function HistoryDetail() {
	const { selectedRunId, navigateToHistory } = useAppStore();

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
		<div className="flex-1 overflow-auto p-6 space-y-6">
			{/* Header */}
			<div className="flex items-center gap-4">
				<Button
					variant="ghost"
					size="icon"
					onClick={navigateToHistory}
				>
					<ArrowLeft className="w-5 h-5" />
				</Button>
				<div>
					<h1 className="text-xl font-semibold text-foreground">Run Report</h1>
					<p className="text-sm text-muted-foreground">ID: {selectedRunId}</p>
				</div>
			</div>

			{/* Phase 1: Metadata Card */}
			{report.metadata && (
				<Card>
					<CardHeader>
						<CardTitle>Test Information</CardTitle>
					</CardHeader>
					<CardContent>
						{report.metadata.configuration?.comment && (
							<div className="mb-4 p-3 bg-primary/5 border border-primary/20 rounded">
								<p className="text-xs text-primary font-medium mb-1">Comment</p>
								<p className="text-sm text-foreground">{report.metadata.configuration.comment}</p>
							</div>
						)}
						<div className="grid grid-cols-2 gap-4">
							<div>
								<p className="text-sm text-muted-foreground mb-1">Request</p>
								<p className="text-sm font-medium text-foreground">
									{report.metadata.requestMethod} {report.metadata.requestUrl}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground mb-1">Status</p>
								<p className="text-sm font-medium text-foreground capitalize">
									{report.metadata.status}
								</p>
							</div>
							{report.metadata.configuration && (
								<>
									{report.metadata.configuration.mode && (
										<div>
											<p className="text-sm text-muted-foreground mb-1">Mode</p>
											<p className="text-sm font-medium text-foreground capitalize">
												{report.metadata.configuration.mode}
											</p>
										</div>
									)}
									{report.metadata.configuration.duration && (
										<div>
											<p className="text-sm text-muted-foreground mb-1">Duration</p>
											<p className="text-sm font-medium text-foreground">
												{report.metadata.configuration.duration}
											</p>
										</div>
									)}
									{report.metadata.configuration.concurrency && (
										<div>
											<p className="text-sm text-muted-foreground mb-1">Concurrency</p>
											<p className="text-sm font-medium text-foreground">
												{report.metadata.configuration.concurrency}
											</p>
										</div>
									)}
								</>
							)}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Summary Cards */}
			<div className="grid grid-cols-4 gap-4">
				<Card>
					<CardContent className="pt-4">
						<div className="flex items-center gap-2 mb-2">
							<CheckCircle className="w-5 h-5 text-green-500" />
							<span className="text-sm text-muted-foreground">Total Requests</span>
						</div>
						<p className="text-2xl font-bold text-foreground">
							{formatNumber(report.summary.totalRequests)}
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardContent className="pt-4">
						<div className="flex items-center gap-2 mb-2">
							<XCircle className="w-5 h-5 text-destructive" />
							<span className="text-sm text-muted-foreground">Failed Requests</span>
						</div>
						<p className="text-2xl font-bold text-foreground">
							{formatNumber(report.summary.failedRequests)}
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardContent className="pt-4">
						<div className="flex items-center gap-2 mb-2">
							<Clock className="w-5 h-5 text-blue-500" />
							<span className="text-sm text-muted-foreground">Avg RPS</span>
						</div>
						<p className="text-2xl font-bold text-foreground">
							{formatNumber(report.summary.avgRps)}
						</p>
					</CardContent>
				</Card>

				<Card>
					<CardContent className="pt-4">
						<div className="flex items-center gap-2 mb-2">
							<CheckCircle className="w-5 h-5 text-green-500" />
							<span className="text-sm text-muted-foreground">Success Rate</span>
						</div>
						<p className="text-2xl font-bold text-foreground">
							{successRate.toFixed(1)}%
						</p>
					</CardContent>
				</Card>
			</div>

			{/* Latency Stats */}
			<Card>
				<CardHeader>
					<CardTitle>Latency Statistics</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
						<div>
							<p className="text-sm text-muted-foreground mb-1">Average</p>
							<p className="text-xl font-semibold text-foreground">
								{formatNumber(report.latency.avg)} ms
							</p>
						</div>
						<div>
							<p className="text-sm text-muted-foreground mb-1">P50 (Median)</p>
							<p className="text-xl font-semibold text-foreground">
								{formatNumber(report.latency.p50)} ms
							</p>
						</div>
						{report.latency.p75 !== undefined && (
							<div>
								<p className="text-sm text-muted-foreground mb-1">P75</p>
								<p className="text-xl font-semibold text-foreground">
									{formatNumber(report.latency.p75)} ms
								</p>
							</div>
						)}
						<div>
							<p className="text-sm text-muted-foreground mb-1">P90</p>
							<p className="text-xl font-semibold text-foreground">
								{formatNumber(report.latency.p90)} ms
							</p>
						</div>
						<div>
							<p className="text-sm text-muted-foreground mb-1">P95</p>
							<p className="text-xl font-semibold text-foreground">
								{formatNumber(report.latency.p95)} ms
							</p>
						</div>
						<div>
							<p className="text-sm text-muted-foreground mb-1">P99</p>
							<p className="text-xl font-semibold text-foreground">
								{formatNumber(report.latency.p99)} ms
							</p>
						</div>
						{report.latency.p999 !== undefined && (
							<div>
								<p className="text-sm text-muted-foreground mb-1">P999</p>
								<p className="text-xl font-semibold text-foreground">
									{formatNumber(report.latency.p999)} ms
								</p>
							</div>
						)}
					</div>
				</CardContent>
			</Card>

			{/* Phase 1: Rate Control */}
			{report.rateControl && (
				<Card>
					<CardHeader>
						<CardTitle>Rate Control</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-3 gap-6">
							<div>
								<p className="text-sm text-muted-foreground mb-1">Target RPS</p>
								<p className="text-xl font-semibold text-foreground">
									{formatNumber(report.rateControl.targetRps)}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground mb-1">Actual RPS</p>
								<p className="text-xl font-semibold text-foreground">
									{formatNumber(report.rateControl.actualRps)}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground mb-1">Achievement</p>
								<p className={cn(
									"text-xl font-semibold",
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

			{/* Status Codes */}
			{report.statusCodes && Object.keys(report.statusCodes).length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>Status Codes</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex flex-wrap gap-3">
							{Object.entries(report.statusCodes).map(([code, count]) => {
								const isSuccess = code.startsWith("2");
								const isRedirect = code.startsWith("3");
								const isClientError = code.startsWith("4");

								return (
									<Badge
										key={code}
										variant="secondary"
										className={cn(
											"px-4 py-2 text-sm",
											isSuccess && "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
											isRedirect && "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
											isClientError && "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
											!isSuccess && !isRedirect && !isClientError && "bg-destructive/10 text-destructive"
										)}
									>
										<span className="font-semibold">{code}</span>
										<span className="ml-2">({formatNumber(count)})</span>
									</Badge>
								);
							})}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Errors */}
			{report.errors && report.errors.total > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>Errors</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="space-y-2">
							<div className="flex justify-between items-center p-3 bg-destructive/10 border border-destructive/20 rounded">
								<span className="text-sm text-destructive">Total Errors</span>
								<span className="text-sm font-medium text-destructive">
									{formatNumber(report.errors.total)} ({report.summary.errorRate.toFixed(2)}%)
								</span>
							</div>

							{/* Phase 1: Errors by type */}
							{report.errors.types && Object.entries(report.errors.types).map(([errorType, count]) => (
								<div
									key={errorType}
									className="flex justify-between items-center p-3 bg-destructive/10 border border-destructive/20 rounded"
								>
									<span className="text-sm text-destructive capitalize">{errorType.replace(/_/g, ' ')}</span>
									<span className="text-sm font-medium text-destructive">
										{formatNumber(count as number)} occurrences
									</span>
								</div>
							))}

							{/* Phase 1: Errors by status code */}
							{report.errors.byStatusCode && Object.entries(report.errors.byStatusCode).length > 0 && (
								<div className="mt-4">
									<p className="text-sm font-medium text-foreground mb-2">By Status Code</p>
									<div className="space-y-2">
										{Object.entries(report.errors.byStatusCode).map(([code, count]) => (
											<div
												key={code}
												className="flex justify-between items-center p-3 bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-900 rounded"
											>
												<span className="text-sm text-orange-800 dark:text-orange-300">
													{code === "0" ? "Network/Connection Errors" : `HTTP ${code}`}
												</span>
												<span className="text-sm font-medium text-orange-600 dark:text-orange-400">
													{formatNumber(count as number)} occurrences
												</span>
											</div>
										))}
									</div>
								</div>
							)}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Results Section */}
			{report.results && report.results.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>Request/Response Samples</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-sm text-muted-foreground mb-4">
							Showing {report.results.length} sampled requests
						</p>
						<div className="space-y-3">
							{report.results.map((sample, idx) => (
								<SampleRequestCard key={idx} sample={sample} index={idx} />
							))}
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}

// Sample Request Card Component
function SampleRequestCard({ sample, index }: { sample: any; index: number }) {
	const [isExpanded, setIsExpanded] = useState(false);

	const formatTimestamp = (ts: string) => {
		const date = new Date(ts);
		return date.toLocaleString();
	};

	const getStatusColor = (status: number) => {
		if (status >= 200 && status < 300) return "text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-900";
		if (status >= 400 && status < 500) return "text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-900";
		if (status >= 500) return "text-destructive bg-destructive/10 border-destructive/20";
		return "text-muted-foreground bg-muted border-border";
	};

	return (
		<div className="border border-border rounded-lg overflow-hidden">
			{/* Header - Always Visible */}
			<div
				className="flex items-center justify-between p-4 bg-muted/50 cursor-pointer hover:bg-muted"
				onClick={() => setIsExpanded(!isExpanded)}
			>
				<div className="flex items-center gap-4 flex-1">
					<span className="text-xs font-medium text-muted-foreground">#{index + 1}</span>
					<span className={cn("px-2 py-1 rounded text-xs font-medium border", getStatusColor(sample.statusCode))}>
						{sample.statusCode}
					</span>
					<span className="text-sm text-muted-foreground">{sample.latencyMs.toFixed(2)}ms</span>
					{sample.error && (
						<Badge variant="destructive" className="text-xs">
							Error: {sample.error}
						</Badge>
					)}
					<span className="text-xs text-muted-foreground ml-auto">{formatTimestamp(sample.timestamp)}</span>
				</div>
				<div className="ml-4">
					{isExpanded ? (
						<ChevronUp className="w-4 h-4 text-muted-foreground" />
					) : (
							<ChevronDown className="w-4 h-4 text-muted-foreground" />
					)}
				</div>
			</div>

			{/* Expanded Details */}
			{isExpanded && sample.trace && (
				<div className="p-4 space-y-4 bg-card">
					{/* Timing Breakdown */}
					{(sample.trace.dns_ms !== undefined || sample.trace.connect_ms !== undefined) && (
						<div>
							<h4 className="text-sm font-semibold text-foreground mb-2">Timing Breakdown</h4>
							<div className="grid grid-cols-2 md:grid-cols-5 gap-2">
								{sample.trace.dns_ms !== undefined && (
									<div className="bg-blue-50 dark:bg-blue-950/30 p-2 rounded">
										<p className="text-xs text-muted-foreground">DNS</p>
										<p className="text-sm font-medium text-blue-700 dark:text-blue-300">{sample.trace.dns_ms.toFixed(2)}ms</p>
									</div>
								)}
								{sample.trace.connect_ms !== undefined && (
									<div className="bg-purple-50 dark:bg-purple-950/30 p-2 rounded">
										<p className="text-xs text-muted-foreground">Connect</p>
										<p className="text-sm font-medium text-purple-700 dark:text-purple-300">{sample.trace.connect_ms.toFixed(2)}ms</p>
									</div>
								)}
								{sample.trace.tls_ms !== undefined && (
									<div className="bg-indigo-50 dark:bg-indigo-950/30 p-2 rounded">
										<p className="text-xs text-muted-foreground">TLS</p>
										<p className="text-sm font-medium text-indigo-700 dark:text-indigo-300">{sample.trace.tls_ms.toFixed(2)}ms</p>
									</div>
								)}
								{sample.trace.first_byte_ms !== undefined && (
									<div className="bg-green-50 dark:bg-green-950/30 p-2 rounded">
										<p className="text-xs text-muted-foreground">First Byte</p>
										<p className="text-sm font-medium text-green-700 dark:text-green-300">{sample.trace.first_byte_ms.toFixed(2)}ms</p>
									</div>
								)}
								{sample.trace.download_ms !== undefined && (
									<div className="bg-yellow-50 dark:bg-yellow-950/30 p-2 rounded">
										<p className="text-xs text-muted-foreground">Download</p>
										<p className="text-sm font-medium text-yellow-700 dark:text-yellow-300">{sample.trace.download_ms.toFixed(2)}ms</p>
									</div>
								)}
							</div>
						</div>
					)}

					{/* Request Headers */}
					{sample.trace.requestHeaders && (
						<div>
							<h4 className="text-sm font-semibold text-foreground mb-2">Request Headers</h4>
							<pre className="bg-muted p-3 rounded text-xs overflow-x-auto max-h-40 overflow-y-auto">
								{sample.trace.requestHeaders}
							</pre>
						</div>
					)}

					{/* Request Body */}
					{sample.trace.requestBody && (
						<div>
							<h4 className="text-sm font-semibold text-foreground mb-2">Request Body</h4>
							<pre className="bg-muted p-3 rounded text-xs overflow-x-auto max-h-40 overflow-y-auto">
								{sample.trace.requestBody}
							</pre>
						</div>
					)}

					{/* Response Headers */}
					{sample.trace.responseHeaders && (
						<div>
							<h4 className="text-sm font-semibold text-foreground mb-2">Response Headers</h4>
							<pre className="bg-muted p-3 rounded text-xs overflow-x-auto max-h-40 overflow-y-auto">
								{sample.trace.responseHeaders}
							</pre>
						</div>
					)}

					{/* Response Body */}
					{sample.trace.responseBody && (
						<div>
							<h4 className="text-sm font-semibold text-foreground mb-2">Response Body</h4>
							<pre className="bg-muted p-3 rounded text-xs overflow-x-auto max-h-60 overflow-y-auto">
								{sample.trace.responseBody}
							</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

