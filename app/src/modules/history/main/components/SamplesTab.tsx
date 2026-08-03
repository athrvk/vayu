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
import { EmptyState, SampleRetentionNote, CapturedDataWarning } from "@/components/shared";
import { useRunSamplesQuery } from "@/queries/runs";
import SampleRequestCard from "./SampleRequestCard";
import type { TabProps, SampleResult } from "../../types";

export default function SamplesTab({ report }: TabProps) {
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

	// Fetched only once a row is open, which is the whole reason the captured
	// bodies are not part of the report payload.
	const { data: captured } = useRunSamplesQuery(
		report.metadata?.runId ?? null,
		expandedIndex !== null
	);

	if (!report.results || report.results.length === 0) {
		return (
			<Card>
				{/* The card supplies the frame; EmptyState brings its own padding, so
				    CardContent adds none of its own. */}
				<CardContent className="p-0">
					<EmptyState
						icon={Activity}
						title="No sampled requests"
						description="This run captured no request samples to show."
					/>
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
						{report.results.length} samples shown
					</Badge>
				</div>
			</CardHeader>
			<CardContent className="space-y-2">
				<SampleRetentionNote
					sampling={report.sampling}
					shown={report.results.length}
					budget="traces"
				/>
				<CapturedDataWarning sampling={report.sampling} />
				{report.results.map((sample: SampleResult, idx: number) => (
					<SampleRequestCard
						key={idx}
						sample={sample}
						index={idx}
						isExpanded={expandedIndex === idx}
						onToggle={() => setExpandedIndex(expandedIndex === idx ? null : idx)}
						captured={sample.id === undefined ? undefined : captured?.get(sample.id)}
					/>
				))}
			</CardContent>
		</Card>
	);
}
