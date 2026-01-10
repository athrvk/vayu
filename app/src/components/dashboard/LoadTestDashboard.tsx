import { useEffect } from "react";
import { Activity, StopCircle, Eye, BarChart3, Loader2 } from "lucide-react";
import { useDashboardStore } from "@/stores";
import { useSSE, useRuns } from "@/hooks";
import { apiService } from "@/services";
import { formatNumber, formatBytes } from "@/utils";
import {
	LineChart,
	Line,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
	ResponsiveContainer,
} from "recharts";

export default function LoadTestDashboard() {
	const {
		currentRunId,
		mode,
		isStreaming,
		currentMetrics,
		historicalMetrics,
		finalReport,
		activeView,
		isStopping,
		setActiveView,
		stopRun,
		setFinalReport,
		setStopping,
	} = useDashboardStore();
	const { loadRunReport } = useRuns();

	// Connect to SSE stream for running tests
	useSSE({
		runId: currentRunId,
		enabled: mode === "running" && !!currentRunId,
	});

	// Load final report when test completes
	useEffect(() => {
		if (mode === "completed" && currentRunId && !finalReport) {
			loadRunReport(currentRunId).then((report) => {
				if (report) {
					setFinalReport(report);
				}
			});
		}
	}, [mode, currentRunId, finalReport, loadRunReport, setFinalReport]);

	const handleStop = async () => {
		if (currentRunId) {
			setStopping(true);
			try {
				await apiService.stopRun(currentRunId);
				stopRun();
			} catch (error) {
				console.error("Failed to stop run:", error);
			} finally {
				setStopping(false);
			}
		}
	};

	if (!currentRunId) {
		return (
			<div className="flex-1 flex items-center justify-center text-gray-500">
				<p>No active load test</p>
			</div>
		);
	}

	const displayMetrics =
		mode === "completed" && finalReport
			? {
				// Map new report structure to metrics format
				requests_completed: finalReport.summary.totalRequests,
				requests_failed: finalReport.summary.failedRequests,
				current_rps: finalReport.summary.avgRps,
				latency_p50_ms: finalReport.latency.p50,
				latency_p95_ms: finalReport.latency.p95,
				latency_p99_ms: finalReport.latency.p99,
				avg_latency_ms: finalReport.latency.avg,
				bytes_sent: 0, // Not included in new format
				bytes_received: 0,
			  }
			: currentMetrics;

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Header */}
			<div className="p-4 border-b border-gray-200 bg-white">
				<div className="flex items-center justify-between mb-4">
					<div className="flex items-center gap-3">
						<Activity className="w-6 h-6 text-purple-600" />
						<h2 className="text-xl font-semibold text-gray-900">
							Load Test Dashboard
						</h2>
						{isStreaming && (
							<span className="flex items-center gap-2 px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm">
								<span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
								Live
							</span>
						)}
						{mode === "completed" && (
							<span className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm">
								Completed
							</span>
						)}
					</div>

					<div className="flex items-center gap-2">
						{mode === "running" && (
							<button
								onClick={handleStop}
								disabled={isStopping}
								className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
							>
								{isStopping ? (
									<>
										<Loader2 className="w-4 h-4 animate-spin" />
										Stopping...
									</>
								) : (
									<>
											<StopCircle className="w-4 h-4" />
											Stop Test
									</>
								)}
							</button>
						)}
					</div>
				</div>

				{/* View Toggle */}
				<div className="flex gap-2">
					<button
						onClick={() => setActiveView("metrics")}
						className={`flex items-center gap-2 px-4 py-2 rounded transition-colors ${
							activeView === "metrics"
								? "bg-primary-600 text-white"
								: "bg-gray-100 text-gray-700 hover:bg-gray-200"
						}`}
					>
						<BarChart3 className="w-4 h-4" />
						Metrics Dashboard
					</button>
					<button
						onClick={() => setActiveView("request-response")}
						className={`flex items-center gap-2 px-4 py-2 rounded transition-colors ${
							activeView === "request-response"
								? "bg-primary-600 text-white"
								: "bg-gray-100 text-gray-700 hover:bg-gray-200"
						}`}
					>
						<Eye className="w-4 h-4" />
						Request/Response
					</button>
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-auto p-6 bg-gray-50">
				{activeView === "metrics" ? (
					<MetricsView
						metrics={displayMetrics}
						historicalMetrics={historicalMetrics}
					/>
				) : (
					<RequestResponseView report={finalReport} />
				)}
			</div>
		</div>
	);
}

function MetricsView({ metrics, historicalMetrics }: any) {
	if (!metrics || typeof metrics.requests_completed === 'undefined') {
		return (
			<div className="text-center py-12 text-gray-500">
				<Activity className="w-16 h-16 mx-auto mb-4 text-gray-300" />
				<p>Waiting for metrics...</p>
			</div>
		);
	}

	const successRate =
		metrics.requests_completed > 0
			? ((metrics.requests_completed - (metrics.requests_failed || 0)) /
					metrics.requests_completed) *
			  100
			: 0;

	// Prepare chart data - show all data, deduplicated by second
	// Group by rounded time to avoid multiple points at same second
	const dataBySecond = new Map<number, any>();
	historicalMetrics.forEach((m: any) => {
		const second = Math.round(m.elapsed_seconds);
		// Keep the latest metric for each second
		dataBySecond.set(second, {
			time: second,
			rps: m.current_rps,
			concurrency: m.current_concurrency,
		});
	});

	// Convert to array and sort by time
	const chartData = Array.from(dataBySecond.values()).sort((a, b) => a.time - b.time);

	return (
		<div className="space-y-6">
			{/* Key Metrics */}
			<div className="grid grid-cols-4 gap-4">
				<MetricCard
					label="Total Requests"
					value={formatNumber(metrics.requests_completed)}
					color="blue"
				/>
				<MetricCard
					label="Failed"
					value={formatNumber(metrics.requests_failed ?? 0)}
					color="red"
				/>
				<MetricCard
					label="Success Rate"
					value={`${successRate.toFixed(1)}%`}
					color="green"
				/>
				<MetricCard
					label="Current RPS"
					value={formatNumber(Math.round(metrics.current_rps ?? 0))}
					color="purple"
				/>
			</div>

			{/* Latency Metrics */}
			<div className="bg-white rounded-lg border border-gray-200 p-6">
				<h3 className="text-lg font-semibold text-gray-900 mb-4">Latency</h3>
				<div className="grid grid-cols-4 gap-4">
					<div>
						<p className="text-sm text-gray-600">Average</p>
						<p className="text-2xl font-bold text-gray-900">
							{(metrics.avg_latency_ms ?? 0).toFixed(2)}ms
						</p>
					</div>
					<div>
						<p className="text-sm text-gray-600">P50</p>
						<p className="text-2xl font-bold text-gray-900">
							{(metrics.latency_p50_ms ?? 0).toFixed(2)}ms
						</p>
					</div>
					<div>
						<p className="text-sm text-gray-600">P95</p>
						<p className="text-2xl font-bold text-gray-900">
							{(metrics.latency_p95_ms ?? 0).toFixed(2)}ms
						</p>
					</div>
					<div>
						<p className="text-sm text-gray-600">P99</p>
						<p className="text-2xl font-bold text-gray-900">
							{(metrics.latency_p99_ms ?? 0).toFixed(2)}ms
						</p>
					</div>
				</div>
			</div>

			{/* Charts */}
			{chartData.length > 1 && (
				<>
					<div className="bg-white rounded-lg border border-gray-200 p-6">
						<h3 className="text-lg font-semibold text-gray-900 mb-4">
							Requests per Second
						</h3>
						<ResponsiveContainer width="100%" height={200}>
							<LineChart data={chartData}>
								<CartesianGrid strokeDasharray="3 3" />
								<XAxis
									dataKey="time"
									label={{
										value: "Time (s)",
										position: "insideBottom",
										offset: -5,
									}}
								/>
								<YAxis
									label={{ value: "RPS", angle: -90, position: "insideLeft" }}
								/>
								<Tooltip />
								<Line
									type="monotone"
									dataKey="rps"
									stroke="#8b5cf6"
									strokeWidth={2}
									dot={false}
								/>
							</LineChart>
						</ResponsiveContainer>
					</div>

					<div className="bg-white rounded-lg border border-gray-200 p-6">
						<h3 className="text-lg font-semibold text-gray-900 mb-4">
							Active Connections
						</h3>
						<ResponsiveContainer width="100%" height={200}>
							<LineChart data={chartData}>
								<CartesianGrid strokeDasharray="3 3" />
								<XAxis
									dataKey="time"
									label={{
										value: "Time (s)",
										position: "insideBottom",
										offset: -5,
									}}
								/>
								<YAxis
									label={{ value: "Connections", angle: -90, position: "insideLeft" }}
								/>
								<Tooltip />
								<Line
									type="monotone"
									dataKey="concurrency"
									stroke="#f59e0b"
									strokeWidth={2}
									dot={false}
								/>
							</LineChart>
						</ResponsiveContainer>
					</div>
				</>
			)}

			{/* Throughput */}
			<div className="bg-white rounded-lg border border-gray-200 p-6">
				<h3 className="text-lg font-semibold text-gray-900 mb-4">Throughput</h3>
				<div className="grid grid-cols-2 gap-4">
					<div>
						<p className="text-sm text-gray-600">Bytes Sent</p>
						<p className="text-2xl font-bold text-gray-900">
							{formatBytes(metrics.bytes_sent)}
						</p>
					</div>
					<div>
						<p className="text-sm text-gray-600">Bytes Received</p>
						<p className="text-2xl font-bold text-gray-900">
							{formatBytes(metrics.bytes_received)}
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}

function MetricCard({
	label,
	value,
	color,
}: {
	label: string;
	value: string;
	color: string;
}) {
	const colors = {
		blue: "bg-blue-50 border-blue-200 text-blue-900",
		red: "bg-red-50 border-red-200 text-red-900",
		green: "bg-green-50 border-green-200 text-green-900",
		purple: "bg-purple-50 border-purple-200 text-purple-900",
	};

	return (
		<div
			className={`p-4 rounded-lg border ${
				colors[color as keyof typeof colors]
			}`}
		>
			<p className="text-sm font-medium opacity-75 mb-1">{label}</p>
			<p className="text-2xl font-bold">{value}</p>
		</div>
	);
}

function RequestResponseView({ report }: { report: any }) {
	if (!report) {
		return (
			<div className="text-center py-12 text-gray-500">
				<p>Request/Response view available after test completion</p>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Status Code Distribution */}
			<div className="bg-white rounded-lg border border-gray-200 p-6">
				<h3 className="text-lg font-semibold text-gray-900 mb-4">
					Status Code Distribution
				</h3>
				<div className="grid grid-cols-4 gap-4">
					{Object.entries(report.statusCodes || {}).map(([code, count]) => (
						<div key={code} className="p-3 bg-gray-50 rounded">
							<span className={`font-mono font-bold ${code.startsWith('2') ? 'text-green-600' :
								code.startsWith('3') ? 'text-blue-600' :
									code.startsWith('4') ? 'text-yellow-600' :
										'text-red-600'
								}`}>{code}</span>
							<p className="text-sm text-gray-600">{String(count)} requests</p>
						</div>
					))}
				</div>
			</div>

			{/* Error Details */}
			{report.errors && report.errors.total > 0 && (
				<div className="bg-white rounded-lg border border-gray-200 p-6">
					<h3 className="text-lg font-semibold text-gray-900 mb-4">
						Error Summary
					</h3>
					<div className="space-y-3">
						<div className="flex justify-between">
							<span className="text-gray-600">Total Errors:</span>
							<span className="font-semibold text-red-600">{report.errors.total}</span>
						</div>
						{Object.entries(report.errors.types || {}).map(([type, count]) => (
							<div key={type} className="flex justify-between text-sm">
								<span className="text-gray-600">{type}:</span>
								<span className="font-medium">{String(count)}</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Timing Breakdown */}
			{report.timingBreakdown && (
				<div className="bg-white rounded-lg border border-gray-200 p-6">
					<h3 className="text-lg font-semibold text-gray-900 mb-4">
						Timing Breakdown
					</h3>
					<div className="grid grid-cols-5 gap-4">
						<div>
							<p className="text-sm text-gray-600">DNS</p>
							<p className="font-bold">{report.timingBreakdown.avgDnsMs.toFixed(2)}ms</p>
						</div>
						<div>
							<p className="text-sm text-gray-600">Connect</p>
							<p className="font-bold">{report.timingBreakdown.avgConnectMs.toFixed(2)}ms</p>
						</div>
						<div>
							<p className="text-sm text-gray-600">TLS</p>
							<p className="font-bold">{report.timingBreakdown.avgTlsMs.toFixed(2)}ms</p>
						</div>
						<div>
							<p className="text-sm text-gray-600">First Byte</p>
							<p className="font-bold">{report.timingBreakdown.avgFirstByteMs.toFixed(2)}ms</p>
						</div>
						<div>
							<p className="text-sm text-gray-600">Download</p>
							<p className="font-bold">{report.timingBreakdown.avgDownloadMs.toFixed(2)}ms</p>
						</div>
					</div>
				</div>
			)}

			{/* Slow Requests */}
			{report.slowRequests && report.slowRequests.count > 0 && (
				<div className="bg-white rounded-lg border border-gray-200 p-6">
					<h3 className="text-lg font-semibold text-gray-900 mb-4">
						Slow Requests
					</h3>
					<div className="grid grid-cols-3 gap-4">
						<div>
							<p className="text-sm text-gray-600">Slow Requests</p>
							<p className="font-bold text-orange-600">{report.slowRequests.count}</p>
						</div>
						<div>
							<p className="text-sm text-gray-600">Threshold</p>
							<p className="font-bold">{report.slowRequests.thresholdMs}ms</p>
						</div>
						<div>
							<p className="text-sm text-gray-600">Percentage</p>
							<p className="font-bold">{report.slowRequests.percentage.toFixed(2)}%</p>
						</div>
					</div>
					<p className="text-xs text-gray-500 mt-3">
						Requests that exceeded the configured threshold and were automatically captured
					</p>
				</div>
			)}

			{/* Test Validation Results */}
			{report.testValidation && (
				<div className="bg-white rounded-lg border border-gray-200 p-6">
					<h3 className="text-lg font-semibold text-gray-900 mb-4">
						Test Validation
					</h3>
					<div className="grid grid-cols-4 gap-4">
						<div>
							<p className="text-sm text-gray-600">Samples Tested</p>
							<p className="font-bold">{report.testValidation.samplesTested}</p>
						</div>
						<div>
							<p className="text-sm text-gray-600">Passed</p>
							<p className="font-bold text-green-600">{report.testValidation.testsPassed}</p>
						</div>
						<div>
							<p className="text-sm text-gray-600">Failed</p>
							<p className="font-bold text-red-600">{report.testValidation.testsFailed}</p>
						</div>
						<div>
							<p className="text-sm text-gray-600">Success Rate</p>
							<p className="font-bold">{report.testValidation.successRate.toFixed(1)}%</p>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
