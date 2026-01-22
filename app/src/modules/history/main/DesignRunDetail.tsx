
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DesignRunDetail Component
 *
 * Displays details for a single design mode request execution.
 */

import { XCircle, Clock } from "lucide-react";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Badge,
	ScrollArea,
} from "@/components/ui";
import { TimingBreakdown } from "./components";
import { UnifiedResponseViewer } from "@/components/shared/response-viewer";
import type { DesignRunDetailProps } from "../types";

export default function DesignRunDetail({ report, onBack, runId }: DesignRunDetailProps) {
	// Get the result from the report
	const result = report.results?.[0];
	const trace = result?.trace as any;

	const isError = !!result?.error || result?.statusCode === 0;
	const isSuccess = result?.statusCode && result.statusCode >= 200 && result.statusCode < 300;

	// Build response/request data for the unified viewer
	const responseData = trace?.response
		? {
				body:
					typeof trace.response.body === "object"
						? JSON.stringify(trace.response.body, null, 2)
						: trace.response.body || "",
				headers: trace.response.headers || {},
				status: result?.statusCode || 0,
				statusText: result?.statusCode
					? result.statusCode >= 200 && result.statusCode < 300
						? "OK"
						: "Error"
					: "Error",
				time: result?.latencyMs,
			}
		: null;

	const requestData = trace?.request
		? {
				method: trace.request.method,
				url: trace.request.url,
				headers: trace.request.headers || {},
				body:
					typeof trace.request.body === "object"
						? JSON.stringify(trace.request.body, null, 2)
						: trace.request.body,
			}
		: null;

	return (
		<div className="flex flex-col h-full bg-background">
			{/* Header */}
			<div className="border-b bg-card px-6 py-4">

				{/* Request Summary */}
				<div className="flex items-center gap-3 bg-muted/50 p-3">
					<Badge variant="outline" className="font-mono font-bold shrink-0">
						{trace?.request?.method || report.metadata?.requestMethod || "GET"}
					</Badge>
					<span className="text-sm font-mono text-foreground truncate flex-1">
						{trace?.request?.url || report.metadata?.requestUrl || "Unknown URL"}
					</span>
					<div className="flex items-center gap-3 shrink-0">
						{result?.statusCode !== undefined && (
							<Badge
								variant={
									isError ? "destructive" : isSuccess ? "default" : "outline"
								}
								className="font-mono"
							>
								{result.statusCode === 0 ? "ERR" : result.statusCode}
							</Badge>
						)}
						{result?.latencyMs !== undefined && (
							<div className="flex items-center gap-1 text-sm">
								<Clock className="w-3.5 h-3.5 text-muted-foreground" />
								<span className="font-mono">{result.latencyMs.toFixed(0)}ms</span>
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Content */}
			<ScrollArea className="flex-1">
				<div className="p-6 space-y-4">
					{/* Error Message */}
					{result?.error && (
						<Card className="border-destructive/30 bg-destructive/5">
							<CardContent className="py-4">
								<div className="flex items-start gap-3">
									<XCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
									<div>
										<p className="text-sm font-medium text-destructive mb-1">
											Request Failed
										</p>
										<p className="text-sm text-destructive/80 font-mono">
											{result.error}
										</p>
									</div>
								</div>
							</CardContent>
						</Card>
					)}

					{/* Timing Breakdown */}
					{trace &&
						(trace.dnsMs !== undefined ||
							trace.connectMs !== undefined ||
							trace.tlsMs !== undefined) && (
							<Card>
								<CardHeader className="py-3">
									<CardTitle className="text-sm">Timing Breakdown</CardTitle>
								</CardHeader>
								<CardContent className="pb-4">
									<TimingBreakdown
										dnsMs={trace.dnsMs}
										connectMs={trace.connectMs}
										tlsMs={trace.tlsMs}
										firstByteMs={trace.firstByteMs}
										downloadMs={trace.downloadMs}
									/>
								</CardContent>
							</Card>
						)}

					{/* Request/Response Viewer - Using shared component */}
					{(responseData || requestData) && (
						<UnifiedResponseViewer
							response={responseData}
							request={requestData}
							compact
							showActions={false}
							className="min-h-[300px]"
						/>
					)}

					{/* Metadata */}
					{report.metadata && (
						<Card>
							<CardHeader className="py-3">
								<CardTitle className="text-sm">Run Details</CardTitle>
							</CardHeader>
							<CardContent className="pb-4">
								<div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
									<div>
										<p className="text-xs text-muted-foreground mb-1">Run ID</p>
										<p className="font-mono text-xs truncate">{runId}</p>
									</div>
									<div>
										<p className="text-xs text-muted-foreground mb-1">
											Start Time
										</p>
										<p className="text-xs">
											{new Date(report.metadata.startTime).toLocaleString()}
										</p>
									</div>
									{report.metadata.endTime > 0 && (
										<div>
											<p className="text-xs text-muted-foreground mb-1">
												End Time
											</p>
											<p className="text-xs">
												{new Date(report.metadata.endTime).toLocaleString()}
											</p>
										</div>
									)}
									<div>
										<p className="text-xs text-muted-foreground mb-1">
											Duration
										</p>
										<p className="text-xs font-mono">
											{result?.latencyMs?.toFixed(0) || "N/A"}ms
										</p>
									</div>
								</div>
							</CardContent>
						</Card>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
