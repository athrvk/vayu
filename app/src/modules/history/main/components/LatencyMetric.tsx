/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * LatencyMetric Component
 *
 * Displays a latency metric with color coding based on variant.
 */

import { cn } from "@/lib/utils";
import { formatNumber } from "@/utils";

interface LatencyMetricProps {
	label: string;
	value: number;
	variant?: "default" | "primary" | "warning" | "danger";
}

export default function LatencyMetric({ label, value, variant = "default" }: LatencyMetricProps) {
	const colorClass = {
		default: "text-foreground",
		primary: "text-status-running",
		warning: "text-status-stopped",
		danger: "text-status-error",
	}[variant];

	const bgClass = {
		default: "bg-muted/50",
		primary: "bg-status-running/10",
		warning: "bg-status-stopped/10",
		danger: "bg-status-error/10",
	}[variant];

	return (
		<div className={cn("p-3 text-center", bgClass)}>
			<p className="text-xs text-muted-foreground mb-1">{label}</p>
			<p className={cn("text-lg font-bold", colorClass)}>
				{formatNumber(value)}
				<span className="text-xs ml-0.5">ms</span>
			</p>
		</div>
	);
}
