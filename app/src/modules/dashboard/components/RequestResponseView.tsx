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
import { InfoChip } from "./shared";
import { formatPhaseDuration } from "@/components/shared/response-viewer/utils";
import {
	StatusCodeBadge,
	CompactHeadersViewer,
	ResponseBody,
	PHASE_TIPS,
} from "@/components/shared/response-viewer";
import { httpStatusClass, statusCodeLabel, STATUS_CLASS_STYLE } from "@/constants/http-status";

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

export default function RequestResponseView({ report }: RequestResponseViewProps) {
	const [expandedResults, setExpandedResults] = useState<Set<number>>(new Set());

	if (!report) {
		return (
			<div className="p-5 text-center py-12 text-muted-foreground">
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
		<div className="p-5 space-y-4">
			{/* Status Code Distribution */}
			<Card>
				<CardHeader>
					<CardTitle className="text-lg">Status Code Distribution</CardTitle>
				</CardHeader>
				<CardContent>
					{hasStatusCodes ? (
						<div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3">
							{Object.entries(statusCodes).map(([code, count]) => (
								<div
									key={code}
									className="p-3 bg-card border border-border rounded-md"
								>
									{/*
									 * `constants/http-status`, not a local ternary. This
									 * one put 3xx on `status-running` - the blue that
									 * means "a run is in progress" - which was the
									 * fourth different answer for 3xx in the app.
									 */}
									<span
										className={cn(
											"font-mono font-bold text-lg",
											STATUS_CLASS_STYLE[httpStatusClass(Number(code))].text
										)}
									>
										{statusCodeLabel(Number(code))}
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
								<span className="font-semibold text-destructive-text">
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
						<div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3">
							<div>
								<p className="text-sm text-muted-foreground">
									DNS <InfoChip tip={PHASE_TIPS.dns} />
								</p>
								<p className="font-bold">
									{formatPhaseDuration(report.timingBreakdown.avgDnsMs).value}
									{formatPhaseDuration(report.timingBreakdown.avgDnsMs).unit}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">
									Connect <InfoChip tip={PHASE_TIPS.connect} />
								</p>
								<p className="font-bold">
									{formatPhaseDuration(report.timingBreakdown.avgConnectMs).value}
									{formatPhaseDuration(report.timingBreakdown.avgConnectMs).unit}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">
									TLS <InfoChip tip={PHASE_TIPS.tls} />
								</p>
								<p className="font-bold">
									{formatPhaseDuration(report.timingBreakdown.avgTlsMs).value}
									{formatPhaseDuration(report.timingBreakdown.avgTlsMs).unit}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">
									First Byte <InfoChip tip={PHASE_TIPS.ttfb} />
								</p>
								<p className="font-bold">
									{
										formatPhaseDuration(report.timingBreakdown.avgFirstByteMs)
											.value
									}
									{
										formatPhaseDuration(report.timingBreakdown.avgFirstByteMs)
											.unit
									}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">
									Download <InfoChip tip={PHASE_TIPS.download} />
								</p>
								<p className="font-bold">
									{
										formatPhaseDuration(report.timingBreakdown.avgDownloadMs)
											.value
									}
									{formatPhaseDuration(report.timingBreakdown.avgDownloadMs).unit}
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
						<div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3">
							<div>
								<p className="text-sm text-muted-foreground">Slow Requests</p>
								<p className="font-bold text-status-stopped-text">
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
									{report.slowRequests.percentage.toFixed(1)}%
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
						<div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3">
							<div>
								<p className="text-sm text-muted-foreground">Samples Tested</p>
								<p className="font-bold">{report.testValidation.samplesTested}</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Passed</p>
								<p className="font-bold text-status-success-text">
									{report.testValidation.testsPassed}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Failed</p>
								<p className="font-bold text-destructive-text">
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

									// One data-driven list, not five hand-rolled cards each
									// with its own `.toFixed(1)`. `formatPhaseDuration` (imported
									// above and already used for the run-level averages) keeps
									// the significant-digit ladder a raw fixed precision drops -
									// a 0.04ms cached DNS lookup no longer rounds to `0.0ms`.
									const timingPhases: {
										label: string;
										value: number;
										tip: string;
									}[] = (
										[
											{
												label: "DNS",
												value: result.trace?.dnsMs,
												tip: PHASE_TIPS.dns,
											},
											{
												label: "Connect",
												value: result.trace?.connectMs,
												tip: PHASE_TIPS.connect,
											},
											{
												label: "TLS",
												value: result.trace?.tlsMs,
												tip: PHASE_TIPS.tls,
											},
											{
												label: "TTFB",
												value: result.trace?.firstByteMs,
												tip: PHASE_TIPS.ttfb,
											},
											{
												label: "Download",
												value: result.trace?.downloadMs,
												tip: PHASE_TIPS.download,
											},
										] as {
											label: string;
											value: number | undefined;
											tip: string;
										}[]
									).filter(
										(p): p is { label: string; value: number; tip: string } =>
											p.value !== undefined
									);

									return (
										<div key={index} className="border-b last:border-b-0">
											{/* Result Header - Clickable */}
											<Button
												variant="ghost"
												className="w-full justify-start px-4 py-3 h-auto hover:bg-muted/50"
												onClick={() => toggleResult(index)}
											>
												<div className="flex flex-wrap items-center gap-x-3 gap-y-2 w-full">
													{isExpanded ? (
														<ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
													) : (
														<ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
													)}

													{/* Status Icon */}
													{isError ? (
														<AlertCircle className="w-4 h-4 text-destructive-text shrink-0" />
													) : isSlow ? (
														<Clock className="w-4 h-4 text-status-stopped-text shrink-0" />
													) : (
														<CheckCircle2 className="w-4 h-4 text-status-success-text shrink-0" />
													)}

													{/* Request Number */}
													<span className="text-xs text-muted-foreground font-mono min-w-8">
														#{result.trace?.request_number ?? index}
													</span>

													{/* Status Code */}
													<StatusCodeBadge
														status={result.statusCode}
														statusText={result.statusText}
														className="shrink-0"
													/>

													{/* Latency */}
													<span
														className={cn(
															"text-sm font-mono shrink-0",
															isSlow && "text-status-stopped-text"
														)}
													>
														{result.latencyMs.toFixed(1)}ms
													</span>

													{/* Timestamp */}
													<span className="text-xs text-muted-foreground sm:ml-auto">
														{formatTime(result.timestamp)}
													</span>

													{/* Error preview */}
													{isError && result.error && (
														<span className="text-xs text-destructive-text truncate basis-full sm:basis-auto sm:max-w-[200px]">
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
															<p className="text-sm bg-destructive/10 text-destructive-text p-2 rounded-md font-mono text-xs break-all">
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

															{/* Timing Breakdown - camelCase phase fields from the
															    load-test trace, formatted through the shared
															    `formatPhaseDuration`. */}
															{timingPhases.length > 0 && (
																<div className="space-y-1">
																	<p className="text-xs font-medium text-muted-foreground">
																		Timing Breakdown
																	</p>
																	<div className="grid grid-cols-[repeat(auto-fit,minmax(90px,1fr))] gap-2 text-xs">
																		{timingPhases.map(
																			(phase) => {
																				const d =
																					formatPhaseDuration(
																						phase.value
																					);
																				return (
																					<div
																						key={
																							phase.label
																						}
																						className="bg-card border border-border rounded-md p-2 text-center"
																					>
																						<p className="text-muted-foreground">
																							{
																								phase.label
																							}{" "}
																							<InfoChip
																								tip={
																									phase.tip
																								}
																							/>
																						</p>
																						<p className="font-mono font-medium">
																							{
																								d.value
																							}
																							{d.unit}
																						</p>
																					</div>
																				);
																			}
																		)}
																	</div>
																</div>
															)}

															{/* Slow Request Warning */}
															{result.trace.isSlow && (
																<div className="flex items-center gap-2 text-xs bg-destructive/10 text-destructive-text p-2 rounded-md">
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

															{/* Response Headers - the shared compact viewer. It
															    declares its own `surface-sunken`, so its row rules
															    resolve correctly on this `bg-muted/30` panel where a
															    bare `border-rule` would fall back to invisible. */}
															{result.trace.headers && (
																<CompactHeadersViewer
																	headers={result.trace.headers}
																	title="Response Headers"
																	className="max-h-40 overflow-auto"
																/>
															)}

															{/* Response Body - the shared viewer (pretty/raw/preview
															    with body-type detection), not a raw `<pre>`. */}
															{result.trace.body && (
																<div className="space-y-1">
																	<p className="text-xs font-medium text-muted-foreground">
																		Response Body
																	</p>
																	<div className="h-48 overflow-hidden rounded-md border border-border">
																		<ResponseBody
																			body={result.trace.body}
																			headers={
																				result.trace
																					.headers || {}
																			}
																			height="100%"
																			compact
																		/>
																	</div>
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
