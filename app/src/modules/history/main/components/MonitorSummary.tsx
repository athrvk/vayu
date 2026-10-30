/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * MonitorSummary Component
 *
 * The per-series min/max/avg the engine recorded for a run's server-vitals
 * scrape. The chart above it answers "when"; this answers "how high did it get",
 * which previously could only be read by hovering the line.
 *
 * It also states the two kinds of missed scrape a chart cannot draw, because
 * both look like an empty panel and need different fixes (#3120): a failure (no
 * 2xx answer, so the URL or the endpoint is at fault, with the engine's cause)
 * and a no-match (answered, but none of the requested names matched).
 */

import type { ReactNode } from "react";
import { fmtVitals } from "@/modules/dashboard/components/charts/uplot";
import type { RunReport } from "@/types";
import { formatNumber } from "@/lib/format-number";
import { Callout } from "@/components/shared";
import { pluralize } from "@/modules/dashboard/utils/format";

type MonitorSection = NonNullable<RunReport["monitor"]>;

interface MonitorSummaryProps {
	monitor: MonitorSection;
	/** The names the run asked for (its config snapshot); absent until it loads. */
	requestedSeries?: string[];
}

/** One metric's min / avg / max, plus how many scrapes actually carried it. */
function SeriesCard({
	name,
	stats,
	samples,
}: {
	name: string;
	stats: MonitorSection["series"][string];
	samples: number;
}) {
	return (
		<div className="p-3 bg-muted/50 rounded-md">
			<div className="flex items-baseline justify-between gap-2 mb-2">
				<p className="text-xs font-medium text-foreground truncate" title={name}>
					{name}
				</p>
				{/* Only when it disagrees with the run's sample count: equal counts
				    say nothing, while a smaller one is the reason a line looks
				    sparse - the metric was missing from the other scrapes. */}
				{stats.count !== samples && (
					<p className="text-xs text-muted-foreground shrink-0">
						{formatNumber(stats.count)} of {formatNumber(samples)}
					</p>
				)}
			</div>
			<div className="grid grid-cols-3 gap-2 text-center">
				{(
					[
						["Min", stats.min],
						["Avg", stats.avg],
						["Max", stats.max],
					] as const
				).map(([label, value]) => (
					<div key={label}>
						<p className="text-xs text-muted-foreground">{label}</p>
						{/* The chart's own formatter, so a peak read here and the
						    same peak read off the line are spelled identically. */}
						<p className="text-sm font-bold text-foreground tabular-nums">
							{fmtVitals(value)}
						</p>
					</div>
				))}
			</div>
		</div>
	);
}

/** Every scrape the engine made, whichever way it went. */
function scrapeCount(monitor: MonitorSection): number {
	return monitor.samples + monitor.failures + (monitor.noMatchScrapes ?? 0);
}

/**
 * The scrapes that got no 2xx answer, with the engine's cause for the last.
 *
 * A run recorded before the engine counted no-matches apart (`noMatchScrapes`
 * absent) folded them into `failures`, so its advice names both causes.
 */
function FailureCallout({ monitor }: { monitor: MonitorSection }): ReactNode {
	if (monitor.failures === 0) return null;
	const total = scrapeCount(monitor);
	const cause = monitor.lastError ? ` (last cause: ${monitor.lastError})` : "";
	const nothingAnswered = monitor.samples === 0 && !monitor.noMatchScrapes;

	if (nothingAnswered) {
		const legacy = monitor.noMatchScrapes === undefined;
		return (
			/* Block-level, not field-level: this is a condition about the whole
			   pane rather than a control refusing a value, so it is a Callout -
			   see the three error levels in docs/design-system.md. */
			<Callout severity="blocking" title="Every scrape failed">
				{formatNumber(monitor.failures)} of {formatNumber(total)}
				{cause}. Nothing was recorded, so there is no chart above - check that the monitor
				URL was reachable from Vayu&apos;s engine for the life of the run
				{legacy ? " and that its output carried the requested metrics" : ""}.
			</Callout>
		);
	}
	return (
		<Callout severity={monitor.samples === 0 ? "blocking" : "warning"}>
			{formatNumber(monitor.failures)} of {formatNumber(total)} scrapes failed{cause}
			{monitor.samples > 0 ? " - the gaps in the chart are those." : "."}
		</Callout>
	);
}

/**
 * The 2xx answers that carried none of the requested names: the endpoint is
 * healthy and the names are wrong, which a failure's "check the URL" would send
 * the user away from.
 */
function NoMatchCallout({
	monitor,
	requestedSeries,
}: {
	monitor: MonitorSection;
	requestedSeries?: string[];
}): ReactNode {
	const noMatch = monitor.noMatchScrapes ?? 0;
	if (noMatch === 0) return null;
	const total = scrapeCount(monitor);
	const names =
		requestedSeries && requestedSeries.length > 0 ? (
			<>
				: <span className="font-mono">{requestedSeries.join(", ")}</span>
			</>
		) : (
			" the requested metrics"
		);

	if (monitor.samples === 0) {
		return (
			<Callout severity="blocking" title="No scrape carried the requested metrics">
				The endpoint answered {formatNumber(noMatch)} of {formatNumber(total)}{" "}
				{pluralize(total, "scrape")} but carried none of{names}. Check the names against the
				endpoint&apos;s output, and that the output is in the format the monitor was set to
				read.
			</Callout>
		);
	}
	return (
		<Callout severity="warning">
			{formatNumber(noMatch)} of {formatNumber(total)} scrapes were answered but carried none
			of{names} - the chart has gaps there too.
		</Callout>
	);
}

export default function MonitorSummary({ monitor, requestedSeries }: MonitorSummaryProps) {
	const series = Object.entries(monitor.series ?? {}).sort(([a], [b]) => a.localeCompare(b));

	return (
		<div className="space-y-3">
			<FailureCallout monitor={monitor} />
			<NoMatchCallout monitor={monitor} requestedSeries={requestedSeries} />

			{series.length > 0 && (
				<>
					<div className="grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3 gap-3">
						{series.map(([name, stats]) => (
							<SeriesCard
								key={name}
								name={name}
								stats={stats}
								samples={monitor.samples}
							/>
						))}
					</div>
					<p className="text-xs text-muted-foreground">
						Over {formatNumber(monitor.samples)} {pluralize(monitor.samples, "scrape")}.
					</p>
				</>
			)}
		</div>
	);
}
