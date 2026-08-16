/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * OverviewTab Component
 *
 * Displays test configuration, summary statistics, status codes, and errors.
 */

import { AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";
import { CapacitySummary, ContractCoverage, ThresholdVerdict } from "@/components/shared";
import { HeroRow } from "@/modules/dashboard/components/hero/HeroRow";
import { ModeStatsRow } from "@/modules/dashboard/components/stats/ModeStatsRow";
import { RunEvents } from "./RunEvents";
import type { TabProps } from "../../types";
import { httpStatusClass, statusCodeLabel, STATUS_CLASS_STYLE } from "@/constants/http-status";

export default function OverviewTab({ report, derived, anomalies }: TabProps) {
	return (
		<>
			{/* Mode-adaptive summary - same hero cards + stat row the live dashboard shows.
			    Config (mode/duration/concurrency/comment) + request URL/method live in the
			    always-visible header strip, so no separate "Test Configuration" card here. */}
			<HeroRow d={derived} />
			<ModeStatsRow d={derived} />

			{/* Directly under the numbers it judges - the verdict is the first
			    question a stored run is opened to answer. Absent for a run that
			    declared no budgets, which is every run recorded before them. */}
			<ThresholdVerdict verdict={report.thresholdValidation} />

			{/* What the search found, for a capacity run. Beside the verdict
			    rather than below the charts: "what can it take" is the question
			    the run was started to answer. Absent for every other mode. */}
			<CapacitySummary capacity={report.capacity} />

			{/* Whether the run touched the contract it was measured against.
			    Beside the verdict rather than below the charts, and for the same
			    reason: a run can meet every budget while never calling four of
			    eighteen operations. Absent for a run of an unbound collection. */}
			<ContractCoverage coverage={report.coverage} />

			{/* When the run went wrong, in words. Above the status/error totals
			    because those are cumulative and this is the thing they hide: a
			    3-second collapse and a steady 0.4% failure rate can produce the
			    same summary row. */}
			<RunEvents anomalies={anomalies} />

			{/* Status Codes */}
			{report.statusCodes && Object.keys(report.statusCodes).length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">Status Code Distribution</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
							{Object.entries(report.statusCodes).map(
								([code, count]: [string, number]) => {
									/*
									 * One vocabulary, from `constants/http-status`. These tiles
									 * used raw palette classes and their own branches, which put
									 * 3xx on blue while the badge said amber and the chart said
									 * violet - and painted a 5xx and a connection failure the
									 * same red, so "the server erred" and "there was no server"
									 * were indistinguishable at a glance.
									 */
									const style = STATUS_CLASS_STYLE[httpStatusClass(Number(code))];

									return (
										<div
											key={code}
											className={cn(
												"p-3 border border-border text-center",
												style.tint
											)}
										>
											<p
												className={cn(
													"text-lg font-bold font-mono mb-0.5",
													style.text
												)}
											>
												{statusCodeLabel(Number(code))}
											</p>
											<p className="text-xs text-muted-foreground">
												{formatNumber(count)} reqs
											</p>
										</div>
									);
								}
							)}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Errors */}
			{report.errors && report.errors.total > 0 && (
				<Card className="border-destructive/30">
					<CardHeader>
						<CardTitle className="text-base flex items-center gap-2 text-destructive-text">
							<AlertCircle className="w-5 h-5" />
							Error Summary
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<div className="flex justify-between items-center p-3 bg-destructive/10 border border-destructive/20">
							<span className="text-sm font-medium text-destructive-text">
								Total Errors
							</span>
							<span className="text-lg font-bold text-destructive-text">
								{formatNumber(report.errors.total)} (
								{report.summary.errorRate.toFixed(2)}%)
							</span>
						</div>

						{report.errors.types && Object.entries(report.errors.types).length > 0 && (
							<div className="space-y-2">
								<p className="text-xs font-medium text-muted-foreground">
									By Error Type
								</p>
								{Object.entries(report.errors.types).map(([errorType, count]) => (
									<div
										key={errorType}
										className="flex justify-between items-center p-2 bg-muted rounded-md text-sm"
									>
										<span className="capitalize">
											{errorType.replace(/_/g, " ")}
										</span>
										<span className="font-medium">
											{formatNumber(count as number)}
										</span>
									</div>
								))}
							</div>
						)}

						{report.errors.byStatusCode &&
							Object.entries(report.errors.byStatusCode).length > 0 && (
								<div className="space-y-2">
									<p className="text-xs font-medium text-muted-foreground">
										By Status Code
									</p>
									{Object.entries(report.errors.byStatusCode).map(
										([code, count]) => (
											<div
												key={code}
												className="flex justify-between items-center p-2 bg-muted rounded-md text-sm"
											>
												<span className="font-mono">
													{code === "0"
														? "Network/Connection"
														: `HTTP ${code}`}
												</span>
												<span className="font-medium">
													{formatNumber(count as number)}
												</span>
											</div>
										)
									)}
								</div>
							)}
					</CardContent>
				</Card>
			)}
		</>
	);
}
