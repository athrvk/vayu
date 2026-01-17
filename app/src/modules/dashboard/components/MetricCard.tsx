
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * MetricCard Component
 *
 * Displays a single metric with title, value, and optional subtitle/trend
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { MetricCardProps } from "../types";

const colorClasses = {
	default: "",
	success: "text-green-600 dark:text-green-400",
	warning: "text-yellow-600 dark:text-yellow-400",
	danger: "text-red-600 dark:text-red-400",
};

export default function MetricCard({
	title,
	value,
	subtitle,
	trend,
	color = "default",
}: MetricCardProps) {
	return (
		<Card>
			<CardHeader className="pb-2">
				<CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
			</CardHeader>
			<CardContent>
				<div className={cn("text-2xl font-bold", colorClasses[color])}>{value}</div>
				{subtitle && (
					<p className="text-xs text-muted-foreground mt-1">
						{trend === "up" && "↑ "}
						{trend === "down" && "↓ "}
						{subtitle}
					</p>
				)}
			</CardContent>
		</Card>
	);
}
