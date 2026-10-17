/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RunKeyMetrics Component
 *
 * The p99-led glance at the top of the Overview tab: the latency the run is
 * judged on, how much it sent and how much of it worked.
 */

import { Activity, CheckCircle, TrendingUp } from "lucide-react";
import { formatMs, formatNumber, formatPercent } from "@/lib/format-number";
import type { RunReport } from "@/types";

function successRateOf(summary: RunReport["summary"]): number {
	if (summary.totalRequests <= 0) return 0;
	return ((summary.totalRequests - summary.failedRequests) / summary.totalRequests) * 100;
}

export default function RunKeyMetrics({ report }: { report: RunReport }) {
	return (
		<div className="grid grid-cols-1 @md:grid-cols-3 gap-3">
			<div className="bg-muted/50 p-3">
				<div className="flex items-center gap-2 mb-1">
					{/* Raw palette, and staying. Measured 3.50 light / 3.66 dark on
					    this tile against the 3.0 icon bar - it clears it in both
					    themes, and there is no violet semantic token to move it to. */}
					<TrendingUp className="size-icon text-purple-500" />
					<span className="text-xs text-muted-foreground">P99 latency</span>
				</div>
				<p className="text-lg font-bold text-foreground">
					{formatMs(report.latency.p99)}ms
				</p>
			</div>
			<div className="bg-muted/50 p-3">
				<div className="flex items-center gap-2 mb-1">
					<Activity className="size-icon text-primary" />
					<span className="text-xs text-muted-foreground">Total requests</span>
				</div>
				<p className="text-lg font-bold text-foreground">
					{formatNumber(report.summary.totalRequests)}
				</p>
			</div>
			<div className="bg-muted/50 p-3">
				<div className="flex items-center gap-2 mb-1">
					<CheckCircle className="size-icon text-status-success-text" />
					<span className="text-xs text-muted-foreground">Success rate</span>
				</div>
				<p className="text-lg font-bold text-foreground">
					{formatPercent(successRateOf(report.summary))}%
				</p>
			</div>
		</div>
	);
}
