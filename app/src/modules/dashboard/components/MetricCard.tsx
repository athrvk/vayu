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

/*
 * Tokens, not palette literals. These were hand-paired Tailwind shades
 * (`text-green-600 dark:text-green-400`), which is the thing the design system
 * exists to prevent: they do not track the theme, and each pair was tuned by
 * eye rather than against a contrast target. The `-text` variants are the
 * purpose-built accessible pairs for exactly these three states and carry
 * their own light/dark values, so the `dark:` half is no longer needed.
 */
const colorClasses = {
	default: "",
	success: "text-success-text",
	warning: "text-warning-text",
	danger: "text-destructive-text",
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
