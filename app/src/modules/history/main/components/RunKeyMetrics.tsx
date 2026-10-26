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
 * judged on, how much it sent and how much of it worked. Success rate is the
 * HTTP one; a scenario run with failed assertions (#2820) gains a fourth tile
 * for them, because a run whose every assertion failed against `200`s reads
 * 100.0% here and the tile is the only place that says otherwise at a glance.
 */

import type { ReactNode } from "react";
import { Activity, CheckCircle, TrendingUp, XCircle } from "lucide-react";
import { exactAssertionsOf } from "@/components/shared";
import { formatLatencyOrDash, formatNumber, formatPercent } from "@/lib/format-number";
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
	const assertionsFailed = exactAssertionsOf(report)?.failed ?? 0;
	const unrecorded = unrecordedFiguresOf(report);
	return (
		<div
			className={
				assertionsFailed > 0
					? "grid grid-cols-1 @md:grid-cols-4 gap-3"
					: "grid grid-cols-1 @md:grid-cols-3 gap-3"
			}
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
					{formatLatencyOrDash(report.latency?.p99)}
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
						<XCircle className="size-icon text-destructive-text" />
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
