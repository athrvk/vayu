/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * LatencyMetric Component
 *
 * A latency tile. Neutral unless the value exceeds the user's SLO, and then it
 * takes the tier its `severity` names: which percentile a tile is says nothing
 * about whether the run was slow, so the tier is never unconditional (#2245).
 */

import { cn } from "@/lib/utils";
import { formatLatencyParts } from "@/lib/format-number";

interface LatencyMetricProps {
	label: string;
	value: number;
	/** The SLO in ms. Omit it and the tile stays neutral. */
	sloMs?: number;
	/** The tier the tile takes once `value` exceeds `sloMs`. */
	severity?: "warning" | "danger";
}

const TIER_TEXT = {
	neutral: "text-foreground",
	warning: "text-status-stopped-text",
	danger: "text-status-error-text",
};

const TIER_BG = {
	neutral: "bg-muted/50",
	warning: "bg-status-stopped/10",
	danger: "bg-status-error/10",
};

export default function LatencyMetric({ label, value, sloMs, severity }: LatencyMetricProps) {
	const tier = severity && sloMs !== undefined && value > sloMs ? severity : "neutral";
	const { value: digits, unit } = formatLatencyParts(value);

	return (
		<div className={cn("p-3 text-center", TIER_BG[tier])}>
			<p className="text-xs text-muted-foreground mb-1">{label}</p>
			<p className={cn("text-lg font-bold", TIER_TEXT[tier])}>
				{digits}
				<span className="text-xs ml-0.5">{unit}</span>
			</p>
		</div>
	);
}
