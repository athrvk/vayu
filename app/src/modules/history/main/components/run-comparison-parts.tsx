/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The pieces of a run comparison that the vs-baseline strip and the full
 * compare view draw alike.
 *
 * One file so a fix to how a delta is coloured, how a value gets its unit or
 * how a comparability warning reads lands on both surfaces: a second copy of
 * the warnings list was exactly what #2162 would have had to fix twice.
 */

import { AlertTriangle, ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { formatPercent } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import { METRIC_LABELS, formatValue } from "./run-comparison-format";
import { deltaVerdict, type ComparabilityWarning, type MetricDelta } from "@/lib/run-compare";

/** The change between the two runs, coloured by what it means rather than by its sign. */
export function DeltaChange({ metric }: { metric: MetricDelta }) {
	const verdict = deltaVerdict(metric);
	const tone =
		verdict === "improved"
			? "text-status-success-text"
			: verdict === "regressed"
				? "text-status-error-text"
				: "text-muted-foreground";
	const Arrow =
		metric.delta === null || metric.delta === 0
			? Minus
			: metric.delta > 0
				? ArrowUpRight
				: ArrowDownRight;

	return (
		<span className={cn("flex items-center gap-0.5 text-xs font-medium", tone)}>
			<Arrow className="size-icon-sm shrink-0" />
			{metric.pctChange === null
				? metric.delta === null
					? "vs no baseline value"
					: `${metric.delta > 0 ? "+" : ""}${formatValue(metric.metric, metric.delta)}`
				: `${metric.pctChange > 0 ? "+" : ""}${formatPercent(metric.pctChange)}%`}
		</span>
	);
}

export function DeltaCell({ metric }: { metric: MetricDelta }) {
	return (
		<div className="flex flex-col gap-0.5 min-w-0">
			<span className="text-xs text-muted-foreground">{METRIC_LABELS[metric.metric]}</span>
			{metric.target === null ? (
				// Neither run recorded it. Saying so beats a 0 that reads as a
				// measurement, and beats an em-dash with no explanation.
				<span className="text-sm text-muted-foreground">not recorded</span>
			) : (
				<span className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
					<span className="text-sm font-medium text-foreground">
						{formatValue(metric.metric, metric.target)}
					</span>
					<DeltaChange metric={metric} />
				</span>
			)}
		</div>
	);
}

/**
 * One warning row per way the two runs are not the same experiment: the
 * baseline's (or the compared run's) value, then the open run's. Draws nothing
 * for a like-for-like pair.
 */
export function ComparabilityWarnings({ warnings }: { warnings: ComparabilityWarning[] }) {
	if (warnings.length === 0) return null;
	return (
		<ul className="mt-2 flex flex-col gap-1" aria-label="Comparability warnings">
			{warnings.map((warning) => (
				<li
					key={warning.code}
					className="flex items-start gap-2 text-xs text-status-warning-text"
				>
					<AlertTriangle className="mt-0.5 size-icon-sm shrink-0" />
					<span>
						{warning.message} {warning.base} vs {warning.target}.
					</span>
				</li>
			))}
		</ul>
	);
}
