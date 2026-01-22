
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * PerformanceTab Component
 *
 * Displays latency distribution and rate control metrics.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";
import LatencyMetric from "./LatencyMetric";
import type { TabProps } from "../../types";

export default function PerformanceTab({ report }: TabProps) {
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
						<LatencyMetric
							label="P50 (Median)"
							value={report.latency.p50}
							variant="primary"
						/>
						{report.latency.p75 !== undefined && (
							<LatencyMetric label="P75" value={report.latency.p75} />
						)}
						<LatencyMetric label="P90" value={report.latency.p90} />
						<LatencyMetric label="P95" value={report.latency.p95} variant="warning" />
						<LatencyMetric label="P99" value={report.latency.p99} variant="danger" />
						{report.latency.p999 !== undefined && (
							<LatencyMetric
								label="P999"
								value={report.latency.p999}
								variant="danger"
							/>
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
							<div className="text-center p-4 bg-muted/50">
								<p className="text-xs text-muted-foreground mb-2">Target RPS</p>
								<p className="text-2xl font-bold text-foreground">
									{formatNumber(report.rateControl.targetRps)}
								</p>
							</div>
							<div className="text-center p-4 bg-muted/50">
								<p className="text-xs text-muted-foreground mb-2">Actual RPS</p>
								<p className="text-2xl font-bold text-foreground">
									{formatNumber(report.rateControl.actualRps)}
								</p>
							</div>
							<div className="text-center p-4 bg-muted/50">
								<p className="text-xs text-muted-foreground mb-2">
									Achievement Rate
								</p>
								<p
									className={cn(
										"text-2xl font-bold",
										report.rateControl.achievement >= 95 &&
											report.rateControl.achievement <= 105
											? "text-green-600 dark:text-green-400"
											: report.rateControl.achievement >= 80 &&
												  report.rateControl.achievement <= 120
												? "text-yellow-600 dark:text-yellow-400"
												: "text-destructive"
									)}
								>
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
