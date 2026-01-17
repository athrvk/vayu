
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestResponseView Component
 *
 * Displays status codes, errors, timing breakdown, sampled requests, and validation results
 */

import { useState } from "react";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Badge,
	Button,
	ScrollArea,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import type { RequestResponseViewProps } from "../types";

// Helper to format timestamp
function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	const timeStr = date.toLocaleTimeString("en-US", {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	// Add milliseconds manually
	const ms = String(date.getMilliseconds()).padStart(3, "0");
	return `${timeStr}.${ms}`;
}

// Helper to get status badge variant
function getStatusBadgeVariant(code: number): "default" | "secondary" | "destructive" | "outline" {
	if (code === 0) return "destructive";
	if (code >= 200 && code < 300) return "default";
	if (code >= 400) return "destructive";
	return "secondary";
}

export default function RequestResponseView({ report }: RequestResponseViewProps) {
	const [expandedResults, setExpandedResults] = useState<Set<number>>(new Set());

	if (!report) {
		return (
			<div className="text-center py-12 text-gray-500">
				<p>Request/Response view available after test completion</p>
			</div>
		);
	}

	const toggleResult = (index: number) => {
		const newExpanded = new Set(expandedResults);
		if (newExpanded.has(index)) {
			newExpanded.delete(index);
		} else {
			newExpanded.add(index);
		}
		setExpandedResults(newExpanded);
	};

	const statusCodes = report.statusCodes || {};
	const hasStatusCodes = Object.keys(statusCodes).length > 0;

	return (
		<div className="space-y-6">
			{/* Status Code Distribution */}
			<Card>
				<CardHeader>
					<CardTitle className="text-lg">Status Code Distribution</CardTitle>
				</CardHeader>
				<CardContent>
					{hasStatusCodes ? (
						<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
							{Object.entries(statusCodes).map(([code, count]) => (
								<div key={code} className="p-3 bg-muted rounded">
									<span
										className={cn(
											"font-mono font-bold text-lg",
											code === "0" && "text-red-600 dark:text-red-400",
											code.startsWith("2") &&
												"text-green-600 dark:text-green-400",
											code.startsWith("3") &&
												"text-blue-600 dark:text-blue-400",
											code.startsWith("4") &&
												"text-yellow-600 dark:text-yellow-400",
											code.startsWith("5") && "text-red-600 dark:text-red-400"
										)}
									>
										{code === "0" ? "Error" : code}
									</span>
									<p className="text-sm text-muted-foreground">
										{String(count)} requests
									</p>
								</div>
							))}
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							No status code data available
						</p>
					)}
				</CardContent>
			</Card>

			{/* Error Details */}
			{report.errors && report.errors.total > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg">Error Summary</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="space-y-3">
							<div className="flex justify-between">
								<span className="text-muted-foreground">Total Errors:</span>
								<span className="font-semibold text-destructive">
									{report.errors.total}
								</span>
							</div>
							{Object.entries(report.errors.types || {}).map(([type, count]) => (
								<div key={type} className="flex justify-between text-sm">
									<span className="text-muted-foreground">{type}:</span>
									<span className="font-medium">{String(count)}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Timing Breakdown */}
			{report.timingBreakdown && (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg">Timing Breakdown</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-5 gap-4">
							<div>
								<p className="text-sm text-muted-foreground">DNS</p>
								<p className="font-bold">
									{report.timingBreakdown.avgDnsMs.toFixed(2)}ms
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Connect</p>
								<p className="font-bold">
									{report.timingBreakdown.avgConnectMs.toFixed(2)}ms
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">TLS</p>
								<p className="font-bold">
									{report.timingBreakdown.avgTlsMs.toFixed(2)}ms
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">First Byte</p>
								<p className="font-bold">
									{report.timingBreakdown.avgFirstByteMs.toFixed(2)}ms
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Download</p>
								<p className="font-bold">
									{report.timingBreakdown.avgDownloadMs.toFixed(2)}ms
								</p>
							</div>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Slow Requests */}
			{report.slowRequests && report.slowRequests.count > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg">Slow Requests</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-3 gap-4">
							<div>
								<p className="text-sm text-muted-foreground">Slow Requests</p>
								<p className="font-bold text-orange-600 dark:text-orange-400">
									{report.slowRequests.count}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Threshold</p>
								<p className="font-bold">{report.slowRequests.thresholdMs}ms</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Percentage</p>
								<p className="font-bold">
									{report.slowRequests.percentage.toFixed(2)}%
								</p>
							</div>
						</div>
						<p className="text-xs text-muted-foreground mt-3">
							Requests that exceeded the configured threshold and were automatically
							captured
						</p>
					</CardContent>
				</Card>
			)}

			{/* Test Validation Results */}
			{report.testValidation && (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg">Test Validation</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-4 gap-4">
							<div>
								<p className="text-sm text-muted-foreground">Samples Tested</p>
								<p className="font-bold">{report.testValidation.samplesTested}</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Passed</p>
								<p className="font-bold text-green-600 dark:text-green-400">
									{report.testValidation.testsPassed}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Failed</p>
								<p className="font-bold text-destructive">
									{report.testValidation.testsFailed}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Success Rate</p>
								<p className="font-bold">
									{report.testValidation.successRate.toFixed(1)}%
								</p>
							</div>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Sampled Request/Response Results */}
			{report.results && report.results.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg flex items-center gap-2">
							Sampled Requests
							<Badge variant="secondary" className="text-xs">
								{report.results.length} captured
							</Badge>
						</CardTitle>
					</CardHeader>
					<CardContent className="p-0">
						<ScrollArea className="h-[400px]">
							<div className="divide-y">
								{report.results.map((result, index) => {
									const isExpanded = expandedResults.has(index);
									const isError = !!result.error || result.statusCode === 0;
									const isSlow = result.trace?.isSlow;

									return (
										<div key={index} className="border-b last:border-b-0">
											{/* Result Header - Clickable */}
											<Button
												variant="ghost"
												className="w-full justify-start px-4 py-3 h-auto rounded-none hover:bg-muted/50"
												onClick={() => toggleResult(index)}
											>
												<div className="flex items-center gap-3 w-full">
													{isExpanded ? (
														<ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
													) : (
														<ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
													)}

													{/* Status Icon */}
													{isError ? (
														<AlertCircle className="w-4 h-4 text-destructive shrink-0" />
													) : isSlow ? (
														<Clock className="w-4 h-4 text-orange-500 shrink-0" />
													) : (
														<CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
													)}

													{/* Request Number */}
													<span className="text-xs text-muted-foreground font-mono w-8">
														#{result.trace?.request_number ?? index}
													</span>

													{/* Status Code */}
													<Badge
														variant={getStatusBadgeVariant(
															result.statusCode
														)}
														className="font-mono shrink-0"
													>
														{result.statusCode === 0
															? "ERR"
															: result.statusCode}
													</Badge>

													{/* Latency */}
													<span
														className={cn(
															"text-sm font-mono shrink-0",
															isSlow &&
																"text-orange-600 dark:text-orange-400"
														)}
													>
														{result.latencyMs.toFixed(1)}ms
													</span>

													{/* Timestamp */}
													<span className="text-xs text-muted-foreground ml-auto">
														{formatTime(result.timestamp)}
													</span>

													{/* Error preview */}
													{isError && result.error && (
														<span className="text-xs text-destructive truncate max-w-[200px]">
															{result.error.split(":")[0]}
														</span>
													)}
												</div>
											</Button>

											{/* Expanded Details */}
											{isExpanded && (
												<div className="px-4 py-3 bg-muted/30 space-y-3">
													{/* Error Message */}
													{result.error && (
														<div className="space-y-1">
															<p className="text-xs font-medium text-muted-foreground">
																Error
															</p>
															<p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 p-2 rounded font-mono text-xs break-all">
																{result.error}
															</p>
														</div>
													)}

													{/* Trace Info */}
													{result.trace && (
														<>
															{result.trace.error_type && (
																<div className="flex gap-4 text-sm">
																	<span className="text-muted-foreground">
																		Error Type:
																	</span>
																	<span className="font-mono">
																		{result.trace.error_type}
																	</span>
																</div>
															)}

															{/* Timing Breakdown - using camelCase field names from backend */}
															{(result.trace.dnsMs !== undefined ||
																result.trace.connectMs !==
																	undefined ||
																result.trace.tlsMs !== undefined ||
																result.trace.firstByteMs !==
																	undefined ||
																result.trace.downloadMs !==
																	undefined) && (
																<div className="space-y-1">
																	<p className="text-xs font-medium text-muted-foreground">
																		Timing Breakdown
																	</p>
																	<div className="grid grid-cols-5 gap-2 text-xs">
																		{result.trace.dnsMs !==
																			undefined && (
																			<div className="bg-muted p-2 rounded text-center">
																				<p className="text-muted-foreground">
																					DNS
																				</p>
																				<p className="font-mono font-medium">
																					{result.trace.dnsMs.toFixed(
																						1
																					)}
																					ms
																				</p>
																			</div>
																		)}
																		{result.trace.connectMs !==
																			undefined && (
																			<div className="bg-muted p-2 rounded text-center">
																				<p className="text-muted-foreground">
																					Connect
																				</p>
																				<p className="font-mono font-medium">
																					{result.trace.connectMs.toFixed(
																						1
																					)}
																					ms
																				</p>
																			</div>
																		)}
																		{result.trace.tlsMs !==
																			undefined && (
																			<div className="bg-muted p-2 rounded text-center">
																				<p className="text-muted-foreground">
																					TLS
																				</p>
																				<p className="font-mono font-medium">
																					{result.trace.tlsMs.toFixed(
																						1
																					)}
																					ms
																				</p>
																			</div>
																		)}
																		{result.trace
																			.firstByteMs !==
																			undefined && (
																			<div className="bg-muted p-2 rounded text-center">
																				<p className="text-muted-foreground">
																					TTFB
																				</p>
																				<p className="font-mono font-medium">
																					{result.trace.firstByteMs.toFixed(
																						1
																					)}
																					ms
																				</p>
																			</div>
																		)}
																		{result.trace.downloadMs !==
																			undefined && (
																			<div className="bg-muted p-2 rounded text-center">
																				<p className="text-muted-foreground">
																					Download
																				</p>
																				<p className="font-mono font-medium">
																					{result.trace.downloadMs.toFixed(
																						1
																					)}
																					ms
																				</p>
																			</div>
																		)}
																	</div>
																</div>
															)}

															{/* Slow Request Warning */}
															{result.trace.isSlow && (
																<div className="flex items-center gap-2 text-xs bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400 p-2 rounded">
																	<Clock className="w-3 h-3" />
																	<span>
																		Slow request:{" "}
																		{result.trace.totalMs?.toFixed(
																			1
																		)}
																		ms
																		{result.trace
																			.thresholdMs && (
																			<span className="text-muted-foreground ml-1">
																				(threshold:{" "}
																				{
																					result.trace
																						.thresholdMs
																				}
																				ms)
																			</span>
																		)}
																	</span>
																</div>
															)}

															{/* Response Headers */}
															{result.trace.headers &&
																Object.keys(result.trace.headers)
																	.length > 0 && (
																	<div className="space-y-1">
																		<p className="text-xs font-medium text-muted-foreground">
																			Response Headers
																		</p>
																		<div className="bg-muted p-2 rounded text-xs font-mono max-h-32 overflow-auto">
																			{Object.entries(
																				result.trace.headers
																			).map(
																				([key, value]) => (
																					<div
																						key={key}
																						className="flex gap-2"
																					>
																						<span className="text-muted-foreground">
																							{key}:
																						</span>
																						<span className="break-all">
																							{value}
																						</span>
																					</div>
																				)
																			)}
																		</div>
																	</div>
																)}

															{/* Response Body */}
															{result.trace.body && (
																<div className="space-y-1">
																	<p className="text-xs font-medium text-muted-foreground">
																		Response Body
																	</p>
																	<pre className="bg-muted p-2 rounded text-xs font-mono max-h-48 overflow-auto whitespace-pre-wrap break-all">
																		{result.trace.body}
																	</pre>
																</div>
															)}
														</>
													)}
												</div>
											)}
										</div>
									);
								})}
							</div>
						</ScrollArea>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
