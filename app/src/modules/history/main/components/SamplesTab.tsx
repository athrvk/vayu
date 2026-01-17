
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * SamplesTab Component
 *
 * Displays sampled request details for load tests.
 */

import { useState } from "react";
import { Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, Badge } from "@/components/ui";
import SampleRequestCard from "./SampleRequestCard";
import type { TabProps, SampleResult } from "../../types";

export default function SamplesTab({ report }: TabProps) {
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

	if (!report.results || report.results.length === 0) {
		return (
			<Card>
				<CardContent className="py-12 text-center">
					<Activity className="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" />
					<p className="text-sm text-muted-foreground">No sampled requests available</p>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle className="text-base">Sampled Request Details</CardTitle>
					<Badge variant="secondary" className="text-xs">
						{report.results.length} samples captured
					</Badge>
				</div>
			</CardHeader>
			<CardContent className="space-y-2">
				{report.results.map((sample: SampleResult, idx: number) => (
					<SampleRequestCard
						key={idx}
						sample={sample as SampleResult}
						index={idx}
						isExpanded={expandedIndex === idx}
						onToggle={() => setExpandedIndex(expandedIndex === idx ? null : idx)}
					/>
				))}
			</CardContent>
		</Card>
	);
}
