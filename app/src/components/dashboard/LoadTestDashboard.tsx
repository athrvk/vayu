import { useEffect } from "react";
import { Activity, StopCircle, Eye, BarChart3 } from "lucide-react";
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
		setActiveView,
		stopRun,
		setFinalReport,
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
			await apiService.stopRun(currentRunId);
			stopRun();
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
					requests_completed: finalReport.total_requests,
					requests_failed: finalReport.total_errors,
					current_rps: finalReport.avg_rps,
					latency_p50_ms: finalReport.latency_p50_ms,
					latency_p95_ms: finalReport.latency_p95_ms,
					latency_p99_ms: finalReport.latency_p99_ms,
					avg_latency_ms: finalReport.avg_latency_ms,
					bytes_sent: finalReport.total_bytes_sent,
					bytes_received: finalReport.total_bytes_received,
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
								className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
							>
								<StopCircle className="w-4 h-4" />
								Stop Test
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
	if (!metrics) {
		return (
			<div className="text-center py-12 text-gray-500">
				<Activity className="w-16 h-16 mx-auto mb-4 text-gray-300" />
				<p>Waiting for metrics...</p>
			</div>
		);
	}

	const successRate =
		metrics.requests_completed > 0
			? ((metrics.requests_completed - metrics.requests_failed) /
					metrics.requests_completed) *
			  100
			: 0;

	// Prepare chart data
	const chartData = historicalMetrics.slice(-60).map((m: any) => ({
		time: m.elapsed_seconds,
		rps: m.current_rps,
		p95: m.latency_p95_ms,
	}));

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
					value={formatNumber(metrics.requests_failed)}
					color="red"
				/>
				<MetricCard
					label="Success Rate"
					value={`${successRate.toFixed(1)}%`}
					color="green"
				/>
				<MetricCard
					label="Current RPS"
					value={formatNumber(Math.round(metrics.current_rps))}
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
							{metrics.avg_latency_ms.toFixed(2)}ms
						</p>
					</div>
					<div>
						<p className="text-sm text-gray-600">P50</p>
						<p className="text-2xl font-bold text-gray-900">
							{metrics.latency_p50_ms.toFixed(2)}ms
						</p>
					</div>
					<div>
						<p className="text-sm text-gray-600">P95</p>
						<p className="text-2xl font-bold text-gray-900">
							{metrics.latency_p95_ms.toFixed(2)}ms
						</p>
					</div>
					<div>
						<p className="text-sm text-gray-600">P99</p>
						<p className="text-2xl font-bold text-gray-900">
							{metrics.latency_p99_ms.toFixed(2)}ms
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
							P95 Latency
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
									label={{ value: "ms", angle: -90, position: "insideLeft" }}
								/>
								<Tooltip />
								<Line
									type="monotone"
									dataKey="p95"
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

function RequestResponseView({ report }: any) {
	if (!report) {
		return (
			<div className="text-center py-12 text-gray-500">
				<p>Request/Response view available after test completion</p>
			</div>
		);
	}

	return (
		<div className="bg-white rounded-lg border border-gray-200 p-6">
			<h3 className="text-lg font-semibold text-gray-900 mb-4">
				Request Details
			</h3>
			<div className="space-y-3 text-sm">
				<div>
					<span className="font-medium text-gray-700">Method:</span>{" "}
					<span className="text-gray-900">{report.request.method}</span>
				</div>
				<div>
					<span className="font-medium text-gray-700">URL:</span>{" "}
					<span className="text-gray-900">{report.request.url}</span>
				</div>
				{report.request.headers &&
					Object.keys(report.request.headers).length > 0 && (
						<div>
							<span className="font-medium text-gray-700 block mb-2">
								Headers:
							</span>
							<pre className="p-3 bg-gray-50 rounded text-xs font-mono overflow-x-auto">
								{JSON.stringify(report.request.headers, null, 2)}
							</pre>
						</div>
					)}
				{report.request.body && (
					<div>
						<span className="font-medium text-gray-700 block mb-2">Body:</span>
						<pre className="p-3 bg-gray-50 rounded text-xs font-mono overflow-x-auto">
							{report.request.body}
						</pre>
					</div>
				)}
			</div>
		</div>
	);
}
