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

import type { ReactNode } from "react";
import { Activity, CheckCircle, ListChecks, TrendingUp } from "lucide-react";
import { formatLatency, formatNumber, formatPercent } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import type { RunReport } from "@/types";
import { NOT_RECORDED, unrecordedFiguresOf } from "./unrecorded-figures";

function successRateOf(summary: RunReport["summary"]): number {
	if (summary.totalRequests <= 0) return 0;
	return ((summary.totalRequests - summary.failedRequests) / summary.totalRequests) * 100;
}

/** A figure, or the placeholder where the engine did not record it (#2895). */
function Figure({ recorded, children }: { recorded: boolean; children: ReactNode }) {
	if (recorded) return <>{children}</>;
	return <span className="text-sm font-normal text-muted-foreground">{NOT_RECORDED}</span>;
}

export default function RunKeyMetrics({ report }: { report: RunReport }) {
	// The Success rate is HTTP-only, so a scenario load run whose assertions all
	// failed reads 100% there; this tile is what keeps the failures in the glance
	// (#2820). It appears only when there are some, so a clean run's row is unchanged.
	const assertionsFailed = report.scenario?.assertions?.failed ?? 0;
	const unrecorded = unrecordedFiguresOf(report.summary);
	return (
		<div
			className={cn(
				"grid grid-cols-1",
				assertionsFailed > 0 ? "@md:grid-cols-4" : "@md:grid-cols-3",
				"gap-3"
			)}
		>
			<div className="bg-muted/50 p-3">
				<div className="flex items-center gap-2 mb-1">
					{/* Raw palette, and staying. Measured 3.50 light / 3.66 dark on
					    this tile against the 3.0 icon bar - it clears it in both
					    themes, and there is no violet semantic token to move it to. */}
					<TrendingUp className="size-icon text-purple-500" />
					<span className="text-xs text-muted-foreground">P99 latency</span>
				</div>
				<p className="text-lg font-bold text-foreground">
					<Figure recorded={!unrecorded.latency}>
						{formatLatency(report.latency.p99)}
					</Figure>
				</p>
			</div>
			<div className="bg-muted/50 p-3">
				<div className="flex items-center gap-2 mb-1">
					<Activity className="size-icon text-primary" />
					<span className="text-xs text-muted-foreground">Total requests</span>
				</div>
				<p className="text-lg font-bold text-foreground">
					<Figure recorded={!unrecorded.counts}>
						{formatNumber(report.summary.totalRequests)}
					</Figure>
				</p>
			</div>
			<div className="bg-muted/50 p-3">
				<div className="flex items-center gap-2 mb-1">
					<CheckCircle className="size-icon text-status-success-text" />
					<span className="text-xs text-muted-foreground">Success rate</span>
				</div>
				<p className="text-lg font-bold text-foreground">
					<Figure recorded={!unrecorded.counts}>
						{formatPercent(successRateOf(report.summary))}%
					</Figure>
				</p>
			</div>
			{assertionsFailed > 0 && (
				<div className="bg-muted/50 p-3">
					<div className="flex items-center gap-2 mb-1">
						<ListChecks className="size-icon text-destructive-text" />
						<span className="text-xs text-muted-foreground">Assertions</span>
					</div>
					<p className="text-lg font-bold text-destructive-text">
						{formatNumber(assertionsFailed)} failed
					</p>
				</div>
			)}
		</div>
	);
}
