/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A run's custom trends, counters and rates - the numbers a `metric.record`
 * element or `pm.metrics.trend` / `.counter` / `.rate` call chose to track,
 * under the name the script gave them (issue #1500).
 *
 * Unlike {@link ThresholdVerdict} these are not judged against anything here:
 * there is no pass/fail, just what the run measured. Silent when the run
 * recorded none - an absent card, not an empty one, for every run that never
 * called `pm.metrics` and every report from an engine that predates it.
 *
 * Two surfaces show it, the same two `ThresholdVerdict` does - the live
 * dashboard's report view and the history detail's Overview - so it lives
 * here once.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import type { RunReport } from "@/types/domain";

/** Trailing zeros are noise on a value the script recorded as a whole number. */
function formatValue(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export interface CustomMetricsSummaryProps {
	customMetrics: RunReport["customMetrics"];
	className?: string;
}

export function CustomMetricsSummary({ customMetrics, className }: CustomMetricsSummaryProps) {
	const entries = customMetrics
		? Object.entries(customMetrics).sort(([a], [b]) => a.localeCompare(b))
		: [];
	if (entries.length === 0) return null;

	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle>Custom metrics</CardTitle>
			</CardHeader>
			<CardContent>
				<ul className="space-y-1.5">
					{entries.map(([name, metric]) => {
						let detail: string;
						let value: string;

						switch (metric.type) {
							case "trend":
								detail = `${metric.count} sample${metric.count === 1 ? "" : "s"}`;
								value = [
									`p50 ${formatValue(metric.p50 ?? 0)}`,
									`p95 ${formatValue(metric.p95 ?? 0)}`,
									`p99 ${formatValue(metric.p99 ?? 0)}`,
								].join(" / ");
								break;
							case "rate":
								detail = `${metric.count} recorded`;
								value = `${formatValue(metric.value ?? 0)}%`;
								break;
							case "counter":
							default:
								detail = `${metric.count} recorded`;
								value = formatValue(metric.value ?? 0);
								break;
						}

						return (
							<li
								key={name}
								className="flex items-baseline justify-between gap-3 text-sm"
							>
								<span className="text-muted-foreground">
									<span className="font-mono">{name}</span>
									<span className="ml-1.5 text-xs">({detail})</span>
								</span>
								<span className="font-mono font-medium">{value}</span>
							</li>
						);
					})}
				</ul>
			</CardContent>
		</Card>
	);
}
