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

import { useMemo, useState } from "react";
import { Activity } from "lucide-react";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Badge,
	ToggleGroup,
	ToggleGroupItem,
} from "@/components/ui";
import { EmptyState, SampleRetentionNote, CapturedDataWarning } from "@/components/shared";
import { formatNumber } from "@/lib/format-number";
import { useRunSamplesQuery } from "@/queries/runs";
import SampleRequestCard from "./SampleRequestCard";
import { sampleResultsWithoutValidationRow } from "../test-validation";
import {
	SAMPLE_FILTERS,
	SAMPLE_FILTER_LABEL,
	countByFilter,
	filterSamples,
	isSampleFilter,
	numberByTime,
	type SampleFilter,
} from "../sample-filter";
import type { TabProps } from "../../types";

interface SamplesTabProps extends TabProps {
	/**
	 * The chip selected. Left out, the tab keeps its own; given, the owner picks
	 * it (a summary row that opens its examples sets it - #2213) and hears the
	 * user's own choice through {@link onFilterChange}.
	 */
	filter?: SampleFilter;
	onFilterChange?: (filter: SampleFilter) => void;
	/**
	 * The row, by number, that is open when the tab mounts. Read once: the tab
	 * unmounts when another is chosen, so the owner decides whether the next
	 * mount gets it again.
	 */
	initialExpandedNumber?: number;
}

// `resultsStored > resultsCap` is the engine's own statement that `results` is a
// selection and not everything stored. A report without the pair predates it
// (#2210), and says nothing rather than guessing.
function storedBeyondCap(report: TabProps["report"]): number | null {
	const { resultsStored, resultsCap } = report;
	if (resultsStored === undefined || resultsCap === undefined) return null;
	return resultsStored > resultsCap ? resultsStored : null;
}

export default function SamplesTab({
	report,
	filter,
	onFilterChange,
	initialExpandedNumber,
}: SamplesTabProps) {
	// Keyed by the row's number, not its array position, so the open row stays the
	// same sample when a chip narrows the list.
	const [expandedNumber, setExpandedNumber] = useState<number | null>(
		initialExpandedNumber ?? null
	);
	const [localFilter, setLocalFilter] = useState<SampleFilter>("all");
	const activeFilter = filter ?? localFilter;

	// Fetched only once a row is open, which is the whole reason the captured
	// bodies are not part of the report payload.
	const { data: captured } = useRunSamplesQuery(
		report.metadata?.runId ?? null,
		expandedNumber !== null
	);

	// The synthetic test-validation row is not a captured request - it carries no
	// response, so this tab would draw it as a status-0 card with nothing behind
	// it. Its failures are named in the Overview instead (issue #726).
	const rows = useMemo(
		() => numberByTime(sampleResultsWithoutValidationRow(report.results)),
		[report.results]
	);
	const counts = useMemo(() => countByFilter(rows), [rows]);
	const visibleRows = useMemo(() => filterSamples(rows, activeFilter), [rows, activeFilter]);
	const storedTotal = storedBeyondCap(report);

	const selectFilter = (next: string) => {
		// Radix emits "" when the active chip is clicked again; a filter is always
		// chosen.
		if (!isSampleFilter(next)) return;
		setLocalFilter(next);
		onFilterChange?.(next);
	};

	if (rows.length === 0) {
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
					<CardTitle>Sampled Request Details</CardTitle>
					<div className="flex items-center gap-2">
						<Badge variant="secondary" className="text-xs">
							{formatNumber(visibleRows.length)} samples shown
						</Badge>
						{storedTotal !== null && (
							<Badge variant="outline" className="text-xs">
								{`${formatNumber(rows.length)} of ${formatNumber(storedTotal)} stored`}
							</Badge>
						)}
					</div>
				</div>
			</CardHeader>
			{/* `p-0` + a `divide-y` strip below - a flat row per sample, not a
			    boxed card per row. The dividers read the `--rule` that `Card`'s
			    `surface-card` declares (issue #1650). */}
			<CardContent className="p-0">
				<SampleRetentionNote
					sampling={report.sampling}
					shown={rows.length}
					budget="traces"
					className="mx-5 mb-3"
				/>
				<CapturedDataWarning sampling={report.sampling} className="mx-5 mb-3" />
				<ToggleGroup
					aria-label="Filter samples"
					value={activeFilter}
					onValueChange={selectFilter}
					className="mx-5 mb-3"
				>
					{SAMPLE_FILTERS.map((value) => (
						<ToggleGroupItem key={value} value={value}>
							{SAMPLE_FILTER_LABEL[value]}
							<span className="tabular-nums text-muted-foreground">
								{formatNumber(counts[value])}
							</span>
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				{visibleRows.length === 0 ? (
					<EmptyState variant="inline" title="No samples match this filter" />
				) : (
					<div className="divide-y divide-rule">
						{visibleRows.map(({ number, sample }) => (
							<SampleRequestCard
								key={number}
								sample={sample}
								index={number - 1}
								runId={report.metadata?.runId}
								isExpanded={expandedNumber === number}
								onToggle={() =>
									setExpandedNumber(expandedNumber === number ? null : number)
								}
								captured={
									sample.id === undefined ? undefined : captured?.get(sample.id)
								}
							/>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
