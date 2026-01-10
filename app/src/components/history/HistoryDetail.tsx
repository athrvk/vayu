import { useEffect, useState } from "react";
import { ArrowLeft, Clock, CheckCircle, XCircle, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { useAppStore } from "@/stores";
import { useRuns } from "@/hooks";
import { formatNumber, formatRelativeTime } from "@/utils";
import type { RunReport } from "@/types";

export default function HistoryDetail() {
	const { selectedRunId, navigateToHistory } = useAppStore();
	const { loadRunReport } = useRuns();
	const [report, setReport] = useState<RunReport | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (selectedRunId) {
			setLoading(true);
			setError(null);
			loadRunReport(selectedRunId)
				.then((data) => {
					if (data) {
						setReport(data);
					} else {
						setError("Failed to load run report");
					}
				})
				.catch((err) => {
					setError(err.message || "Failed to load run report");
				})
				.finally(() => {
					setLoading(false);
				});
		}
	}, [selectedRunId, loadRunReport]);

	if (!selectedRunId) {
		return (
			<div className="flex-1 flex items-center justify-center text-gray-500">
				<p>No run selected</p>
			</div>
		);
	}

	if (loading) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
			</div>
		);
	}

	if (error || !report) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center text-gray-500 space-y-4">
				<AlertCircle className="w-12 h-12 text-red-400" />
				<p>{error || "Report not found"}</p>
				<button
					onClick={navigateToHistory}
					className="px-4 py-2 text-sm bg-primary-600 text-white rounded hover:bg-primary-700"
				>
					Back to History
				</button>
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
				<button
					onClick={navigateToHistory}
					className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
				>
					<ArrowLeft className="w-5 h-5" />
				</button>
				<div>
					<h1 className="text-xl font-semibold text-gray-900">Run Report</h1>
					<p className="text-sm text-gray-500">ID: {selectedRunId}</p>
				</div>
			</div>

			{/* Phase 1: Metadata Card */}
			{report.metadata && (
				<div className="bg-white border border-gray-200 rounded-lg p-6">
					<h2 className="text-lg font-semibold text-gray-900 mb-4">Test Information</h2>
					{report.metadata.configuration?.comment && (
						<div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded">
							<p className="text-xs text-blue-600 font-medium mb-1">Comment</p>
							<p className="text-sm text-blue-900">{report.metadata.configuration.comment}</p>
						</div>
					)}
					<div className="grid grid-cols-2 gap-4">
						<div>
							<p className="text-sm text-gray-600 mb-1">Request</p>
							<p className="text-sm font-medium text-gray-900">
								{report.metadata.requestMethod} {report.metadata.requestUrl}
							</p>
						</div>
						<div>
							<p className="text-sm text-gray-600 mb-1">Status</p>
							<p className="text-sm font-medium text-gray-900 capitalize">
								{report.metadata.status}
							</p>
						</div>
						{report.metadata.configuration && (
							<>
								{report.metadata.configuration.mode && (
									<div>
										<p className="text-sm text-gray-600 mb-1">Mode</p>
										<p className="text-sm font-medium text-gray-900 capitalize">
											{report.metadata.configuration.mode}
										</p>
									</div>
								)}
								{report.metadata.configuration.duration && (
									<div>
										<p className="text-sm text-gray-600 mb-1">Duration</p>
										<p className="text-sm font-medium text-gray-900">
											{report.metadata.configuration.duration}
										</p>
									</div>
								)}
								{report.metadata.configuration.concurrency && (
									<div>
										<p className="text-sm text-gray-600 mb-1">Concurrency</p>
										<p className="text-sm font-medium text-gray-900">
											{report.metadata.configuration.concurrency}
										</p>
									</div>
								)}
							</>
						)}
					</div>
				</div>
			)}

			{/* Summary Cards */}
			<div className="grid grid-cols-4 gap-4">
				<div className="bg-white border border-gray-200 rounded-lg p-4">
					<div className="flex items-center gap-2 mb-2">
						<CheckCircle className="w-5 h-5 text-green-500" />
						<span className="text-sm text-gray-600">Total Requests</span>
					</div>
					<p className="text-2xl font-bold text-gray-900">
						{formatNumber(report.summary.totalRequests)}
					</p>
				</div>

				<div className="bg-white border border-gray-200 rounded-lg p-4">
					<div className="flex items-center gap-2 mb-2">
						<XCircle className="w-5 h-5 text-red-500" />
						<span className="text-sm text-gray-600">Failed Requests</span>
					</div>
					<p className="text-2xl font-bold text-gray-900">
						{formatNumber(report.summary.failedRequests)}
					</p>
				</div>

				<div className="bg-white border border-gray-200 rounded-lg p-4">
					<div className="flex items-center gap-2 mb-2">
						<Clock className="w-5 h-5 text-blue-500" />
						<span className="text-sm text-gray-600">Avg RPS</span>
					</div>
					<p className="text-2xl font-bold text-gray-900">
						{formatNumber(report.summary.avgRps)}
					</p>
				</div>

				<div className="bg-white border border-gray-200 rounded-lg p-4">
					<div className="flex items-center gap-2 mb-2">
						<CheckCircle className="w-5 h-5 text-green-500" />
						<span className="text-sm text-gray-600">Success Rate</span>
					</div>
					<p className="text-2xl font-bold text-gray-900">
						{successRate.toFixed(1)}%
					</p>
				</div>
			</div>

			{/* Latency Stats */}
			<div className="bg-white border border-gray-200 rounded-lg p-6">
				<h2 className="text-lg font-semibold text-gray-900 mb-4">Latency Statistics</h2>
				<div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6">
					<div>
						<p className="text-sm text-gray-600 mb-1">Average</p>
						<p className="text-xl font-semibold text-gray-900">
							{formatNumber(report.latency.avg)} ms
						</p>
					</div>
					<div>
						<p className="text-sm text-gray-600 mb-1">P50 (Median)</p>
						<p className="text-xl font-semibold text-gray-900">
							{formatNumber(report.latency.p50)} ms
						</p>
					</div>
					{report.latency.p75 !== undefined && (
						<div>
							<p className="text-sm text-gray-600 mb-1">P75</p>
							<p className="text-xl font-semibold text-gray-900">
								{formatNumber(report.latency.p75)} ms
							</p>
						</div>
					)}
					<div>
						<p className="text-sm text-gray-600 mb-1">P90</p>
						<p className="text-xl font-semibold text-gray-900">
							{formatNumber(report.latency.p90)} ms
						</p>
					</div>
					<div>
						<p className="text-sm text-gray-600 mb-1">P95</p>
						<p className="text-xl font-semibold text-gray-900">
							{formatNumber(report.latency.p95)} ms
						</p>
					</div>
					<div>
						<p className="text-sm text-gray-600 mb-1">P99</p>
						<p className="text-xl font-semibold text-gray-900">
							{formatNumber(report.latency.p99)} ms
						</p>
					</div>
					{report.latency.p999 !== undefined && (
						<div>
							<p className="text-sm text-gray-600 mb-1">P999</p>
							<p className="text-xl font-semibold text-gray-900">
								{formatNumber(report.latency.p999)} ms
							</p>
						</div>
					)}
				</div>
			</div>

			{/* Phase 1: Rate Control */}
			{report.rateControl && (
				<div className="bg-white border border-gray-200 rounded-lg p-6">
					<h2 className="text-lg font-semibold text-gray-900 mb-4">Rate Control</h2>
					<div className="grid grid-cols-3 gap-6">
						<div>
							<p className="text-sm text-gray-600 mb-1">Target RPS</p>
							<p className="text-xl font-semibold text-gray-900">
								{formatNumber(report.rateControl.targetRps)}
							</p>
						</div>
						<div>
							<p className="text-sm text-gray-600 mb-1">Actual RPS</p>
							<p className="text-xl font-semibold text-gray-900">
								{formatNumber(report.rateControl.actualRps)}
							</p>
						</div>
						<div>
							<p className="text-sm text-gray-600 mb-1">Achievement</p>
							<p className={`text-xl font-semibold ${report.rateControl.achievement >= 95 && report.rateControl.achievement <= 105
								? "text-green-600"
								: report.rateControl.achievement >= 80 && report.rateControl.achievement <= 120
									? "text-yellow-600"
									: "text-red-600"
								}`}>
								{formatNumber(report.rateControl.achievement)}%
							</p>
						</div>
					</div>
				</div>
			)}

			{/* Status Codes */}
			{report.statusCodes && Object.keys(report.statusCodes).length > 0 && (
				<div className="bg-white border border-gray-200 rounded-lg p-6">
					<h2 className="text-lg font-semibold text-gray-900 mb-4">Status Codes</h2>
					<div className="flex flex-wrap gap-3">
						{Object.entries(report.statusCodes).map(([code, count]) => {
							const isSuccess = code.startsWith("2");
							const isRedirect = code.startsWith("3");
							const isClientError = code.startsWith("4");
							const colorClass = isSuccess
								? "bg-green-100 text-green-800"
								: isRedirect
									? "bg-blue-100 text-blue-800"
									: isClientError
										? "bg-yellow-100 text-yellow-800"
										: "bg-red-100 text-red-800";

							return (
								<div
									key={code}
									className={`px-4 py-2 rounded-lg ${colorClass}`}
								>
									<span className="font-semibold">{code}</span>
									<span className="ml-2 text-sm">({formatNumber(count)})</span>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Errors */}
			{report.errors && report.errors.total > 0 && (
				<div className="bg-white border border-gray-200 rounded-lg p-6">
					<h2 className="text-lg font-semibold text-gray-900 mb-4">Errors</h2>
					<div className="space-y-2">
						<div className="flex justify-between items-center p-3 bg-red-50 border border-red-200 rounded">
							<span className="text-sm text-red-800">Total Errors</span>
							<span className="text-sm font-medium text-red-600">
								{formatNumber(report.errors.total)} ({report.summary.errorRate.toFixed(2)}%)
							</span>
						</div>

						{/* Phase 1: Errors by type */}
						{report.errors.types && Object.entries(report.errors.types).map(([errorType, count]) => (
							<div
								key={errorType}
								className="flex justify-between items-center p-3 bg-red-50 border border-red-200 rounded"
							>
								<span className="text-sm text-red-800 capitalize">{errorType.replace(/_/g, ' ')}</span>
								<span className="text-sm font-medium text-red-600">
									{formatNumber(count as number)} occurrences
								</span>
							</div>
						))}

						{/* Phase 1: Errors by status code */}
						{report.errors.byStatusCode && Object.entries(report.errors.byStatusCode).length > 0 && (
							<div className="mt-4">
								<p className="text-sm font-medium text-gray-700 mb-2">By Status Code</p>
								<div className="space-y-2">
									{Object.entries(report.errors.byStatusCode).map(([code, count]) => (
										<div
											key={code}
											className="flex justify-between items-center p-3 bg-orange-50 border border-orange-200 rounded"
										>
											<span className="text-sm text-orange-800">
												{code === "0" ? "Network/Connection Errors" : `HTTP ${code}`}
											</span>
											<span className="text-sm font-medium text-orange-600">
												{formatNumber(count as number)} occurrences
											</span>
										</div>
									))}
								</div>
							</div>
						)}
					</div>
				</div>
			)}

			{/* Results Section */}
			{report.results && report.results.length > 0 && (
				<div className="bg-white rounded-lg shadow-sm p-6">
					<h3 className="text-lg font-semibold text-gray-900 mb-4">
						Request/Response Samples
					</h3>
					<p className="text-sm text-gray-600 mb-4">
						Showing {report.results.length} sampled requests
					</p>
					<div className="space-y-3">
						{report.results.map((sample, idx) => (
							<SampleRequestCard key={idx} sample={sample} index={idx} />
						))}
					</div>
				</div>
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
		if (status >= 200 && status < 300) return "text-green-600 bg-green-50 border-green-200";
		if (status >= 400 && status < 500) return "text-orange-600 bg-orange-50 border-orange-200";
		if (status >= 500) return "text-red-600 bg-red-50 border-red-200";
		return "text-gray-600 bg-gray-50 border-gray-200";
	};

	return (
		<div className="border border-gray-200 rounded-lg overflow-hidden">
			{/* Header - Always Visible */}
			<div
				className="flex items-center justify-between p-4 bg-gray-50 cursor-pointer hover:bg-gray-100"
				onClick={() => setIsExpanded(!isExpanded)}
			>
				<div className="flex items-center gap-4 flex-1">
					<span className="text-xs font-medium text-gray-500">#{index + 1}</span>
					<span className={`px-2 py-1 rounded text-xs font-medium border ${getStatusColor(sample.statusCode)}`}>
						{sample.statusCode}
					</span>
					<span className="text-sm text-gray-600">{sample.latencyMs.toFixed(2)}ms</span>
					{sample.error && (
						<span className="text-xs text-red-600 bg-red-50 px-2 py-1 rounded">
							Error: {sample.error}
						</span>
					)}
					<span className="text-xs text-gray-500 ml-auto">{formatTimestamp(sample.timestamp)}</span>
				</div>
				<div className="ml-4">
					{isExpanded ? (
						<ChevronUp className="w-4 h-4 text-gray-400" />
					) : (
						<ChevronDown className="w-4 h-4 text-gray-400" />
					)}
				</div>
			</div>

			{/* Expanded Details */}
			{isExpanded && sample.trace && (
				<div className="p-4 space-y-4 bg-white">
					{/* Timing Breakdown */}
					{(sample.trace.dns_ms !== undefined || sample.trace.connect_ms !== undefined) && (
						<div>
							<h4 className="text-sm font-semibold text-gray-700 mb-2">Timing Breakdown</h4>
							<div className="grid grid-cols-2 md:grid-cols-5 gap-2">
								{sample.trace.dns_ms !== undefined && (
									<div className="bg-blue-50 p-2 rounded">
										<p className="text-xs text-gray-600">DNS</p>
										<p className="text-sm font-medium text-blue-700">{sample.trace.dns_ms.toFixed(2)}ms</p>
									</div>
								)}
								{sample.trace.connect_ms !== undefined && (
									<div className="bg-purple-50 p-2 rounded">
										<p className="text-xs text-gray-600">Connect</p>
										<p className="text-sm font-medium text-purple-700">{sample.trace.connect_ms.toFixed(2)}ms</p>
									</div>
								)}
								{sample.trace.tls_ms !== undefined && (
									<div className="bg-indigo-50 p-2 rounded">
										<p className="text-xs text-gray-600">TLS</p>
										<p className="text-sm font-medium text-indigo-700">{sample.trace.tls_ms.toFixed(2)}ms</p>
									</div>
								)}
								{sample.trace.first_byte_ms !== undefined && (
									<div className="bg-green-50 p-2 rounded">
										<p className="text-xs text-gray-600">First Byte</p>
										<p className="text-sm font-medium text-green-700">{sample.trace.first_byte_ms.toFixed(2)}ms</p>
									</div>
								)}
								{sample.trace.download_ms !== undefined && (
									<div className="bg-yellow-50 p-2 rounded">
										<p className="text-xs text-gray-600">Download</p>
										<p className="text-sm font-medium text-yellow-700">{sample.trace.download_ms.toFixed(2)}ms</p>
									</div>
								)}
							</div>
						</div>
					)}

					{/* Request Headers */}
					{sample.trace.requestHeaders && (
						<div>
							<h4 className="text-sm font-semibold text-gray-700 mb-2">Request Headers</h4>
							<pre className="bg-gray-50 p-3 rounded text-xs overflow-x-auto max-h-40 overflow-y-auto">
								{sample.trace.requestHeaders}
							</pre>
						</div>
					)}

					{/* Request Body */}
					{sample.trace.requestBody && (
						<div>
							<h4 className="text-sm font-semibold text-gray-700 mb-2">Request Body</h4>
							<pre className="bg-gray-50 p-3 rounded text-xs overflow-x-auto max-h-40 overflow-y-auto">
								{sample.trace.requestBody}
							</pre>
						</div>
					)}

					{/* Response Headers */}
					{sample.trace.responseHeaders && (
						<div>
							<h4 className="text-sm font-semibold text-gray-700 mb-2">Response Headers</h4>
							<pre className="bg-gray-50 p-3 rounded text-xs overflow-x-auto max-h-40 overflow-y-auto">
								{sample.trace.responseHeaders}
							</pre>
						</div>
					)}

					{/* Response Body */}
					{sample.trace.responseBody && (
						<div>
							<h4 className="text-sm font-semibold text-gray-700 mb-2">Response Body</h4>
							<pre className="bg-gray-50 p-3 rounded text-xs overflow-x-auto max-h-60 overflow-y-auto">
								{sample.trace.responseBody}
							</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

