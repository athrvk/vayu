
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * MetricCard Component
 *
 * Displays a single metric with icon, label, and value.
 */

import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui";

interface MetricCardProps {
	icon: ReactNode;
	label: string;
	value: string | number;
	className?: string;
}

export default function MetricCard({ icon, label, value, className = "" }: MetricCardProps) {
	return (
		<Card className={className}>
			<CardContent className="pt-4">
				<div className="flex items-center gap-2 mb-2">
					{icon}
					<span className="text-xs text-muted-foreground">{label}</span>
				</div>
				<p className="text-xl font-bold text-foreground">{value}</p>
			</CardContent>
		</Card>
	);
}
