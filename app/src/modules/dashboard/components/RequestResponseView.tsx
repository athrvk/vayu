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
import { Card, CardContent, CardHeader, CardTitle, Badge, ScrollArea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Clock, XCircle } from "lucide-react";
import type { RequestResponseViewProps } from "../types";
import { InfoChip } from "./shared";
import { formatPhaseDuration } from "@/components/shared/response-viewer/utils";
import {
	CompactHeadersViewer,
	CapturedResponseNotice,
	ResponseBody,
	SampledExchange,
	hasPhaseAverages,
	phasesFromAverages,
	phasesFromTrace,
} from "@/components/shared/response-viewer";
import { SampleRetentionNote, CapturedDataWarning, ThresholdVerdict } from "@/components/shared";
import { useRunSamplesQuery } from "@/queries/runs";
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

	// Fetched only once a row is open. The captured bodies are deliberately not
	// part of the report payload - that response is polled, and this one is not.
	// The hook runs before the early return below, as hooks must.
	const { data: capturedSamples } = useRunSamplesQuery(
		report?.metadata?.runId ?? null,
		expandedResults.size > 0
	);

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

			{/* Timing Breakdown. Gated on the averages themselves, not on the
			    object: `timingBreakdown` also carries the per-phase percentiles,
			    which exist for runs that stored no traces - and this card renders
			    averages only, so it would print five dashes for them. */}
			{hasPhaseAverages(report.timingBreakdown) && (
				<Card>
					<CardHeader>
						<CardTitle className="text-lg">Timing Breakdown</CardTitle>
					</CardHeader>
					<CardContent>
						{/* Run-level averages: five label/value pairs, driven by the
						    shared phase descriptor. This card is the one renderer with
						    room for the spelled-out label, so it reads `longLabel`
						    ("First Byte") where the dense ones read "TTFB". */}
						<div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3">
							{phasesFromAverages(report.timingBreakdown).map((phase) => {
								const duration =
									phase.value !== undefined
										? formatPhaseDuration(phase.value)
										: undefined;
								return (
									<div key={phase.key}>
										<p className="text-sm text-muted-foreground">
											{phase.longLabel} <InfoChip tip={phase.tip} />
										</p>
										<p className="font-bold">
											{duration ? (
												<>
													{duration.value}
													{duration.unit}
												</>
											) : (
												<span className="text-subtle-foreground">-</span>
											)}
										</p>
									</div>
								);
							})}
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

			{/* The whole-run verdict, above the per-response one: a run can meet
			    every assertion and still miss the budget it was run to check. */}
			<ThresholdVerdict verdict={report.thresholdValidation} />

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
						<SampleRetentionNote
							sampling={report.sampling}
							shown={report.testValidation.samplesTested}
							budget="responses"
							className="mt-3"
						/>
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
								{report.results.length} shown
							</Badge>
						</CardTitle>
					</CardHeader>
					<CardContent className="p-0">
						<SampleRetentionNote
							sampling={report.sampling}
							shown={report.results.length}
							budget="traces"
							className="mx-5 mb-3"
						/>
						<CapturedDataWarning sampling={report.sampling} className="mx-5 mb-3" />
						<ScrollArea className="h-[400px]">
							<div className="divide-y">
								{report.results.map((result, index) => {
									const trace = result.trace;
									const captured =
										result.id === undefined
											? undefined
											: capturedSamples?.get(result.id);

									// The phases this sample actually reported, in wire order, from the
									// shared descriptor. Absent ones are dropped: a trace with no TLS is
									// plain HTTP, which is not the same statement as "the handshake took
									// 0ms".
									const phases = phasesFromTrace(trace);

									return (
										<SampledExchange
											key={index}
											label={trace?.request_number ?? index}
											statusCode={result.statusCode}
											statusText={result.statusText}
											latencyMs={result.latencyMs}
											timestamp={formatTime(result.timestamp)}
											error={result.error}
											isSlow={trace?.isSlow}
											phases={phases}
											isExpanded={expandedResults.has(index)}
											onToggle={() => toggleResult(index)}
											className="border-b last:border-b-0"
											details={
												trace && (
													<>
														{trace.error_type && (
															<div className="flex gap-4 text-sm">
																<span className="text-muted-foreground">
																	Error Type:
																</span>
																<span className="font-mono">
																	{trace.error_type}
																</span>
															</div>
														)}

														{/* The data row this result bound (issue #449).
														    A scenario load run stores no per-step
														    `results` rows, so this is the only thing
														    that says which row of the file produced
														    the sample - and for a failure it is the
														    row the reader has to go and look at. */}
														{trace.dataRowIndex !== undefined && (
															<div className="flex gap-4 text-sm">
																<span className="text-muted-foreground">
																	Data Row:
																</span>
																<span className="font-mono">
																	{trace.dataRowIndex}
																</span>
															</div>
														)}

														{/* Per-test validation failures (`validate_scripts` in
														    run_manager.cpp). Before #111 the summary row showed
														    only the opaque `ERR` chip and a count - never which
														    assertions failed or why. Modelled on the
														    request-builder Tests tab. */}
														{trace.failures &&
															trace.failures.length > 0 && (
																<div className="space-y-1">
																	<p className="text-xs font-medium text-muted-foreground">
																		Failed Tests
																		{trace.totalFailed !==
																			undefined && (
																			<span className="ml-1">
																				({trace.totalFailed}
																				)
																			</span>
																		)}
																	</p>
																	<div className="space-y-1.5">
																		{trace.failures.map(
																			(failure, i) => (
																				<div
																					key={i}
																					className="flex items-start gap-2 bg-status-error/10 border border-status-error/20 rounded-md p-2"
																				>
																					<XCircle className="w-4 h-4 text-status-error-text mt-0.5 shrink-0" />
																					<pre className="text-xs text-status-error-text font-mono whitespace-pre-wrap break-words flex-1 min-w-0">
																						{failure}
																					</pre>
																				</div>
																			)
																		)}
																	</div>
																</div>
															)}
													</>
												)
											}
										>
											{/* Slow Request Warning */}
											{trace?.isSlow && (
												<div className="flex items-center gap-2 text-xs bg-destructive/10 text-destructive-text p-2 rounded-md">
													<Clock className="w-3 h-3" />
													<span>
														Slow request: {trace.totalMs?.toFixed(1)}ms
														{trace.thresholdMs && (
															<span className="text-muted-foreground ml-1">
																(threshold: {trace.thresholdMs}ms)
															</span>
														)}
													</span>
												</div>
											)}

											{/* The captured exchange (issue #174). These two blocks used
											    to read flat `trace.headers` / `trace.body`, a shape no
											    engine writer emits at that nesting, so both were dead and
											    this panel showed timing and nothing else. The bodies now
											    come from GET /runs/:id/samples, fetched only once a row is
											    expanded. */}
											{captured && (
												<>
													<CapturedResponseNotice
														response={captured.response}
													/>
													{Object.keys(captured.response.headers).length >
														0 && (
														<CompactHeadersViewer
															headers={captured.response.headers}
															title="Response Headers"
															className="max-h-40 overflow-auto"
														/>
													)}
													{captured.response.body && (
														<div className="space-y-1">
															<p className="text-xs font-medium text-muted-foreground">
																Response Body
															</p>
															<div className="h-48 overflow-hidden rounded-md border border-rule">
																<ResponseBody
																	body={captured.response.body}
																	headers={
																		captured.response.headers
																	}
																	height="100%"
																	compact
																/>
															</div>
														</div>
													)}
												</>
											)}
										</SampledExchange>
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
