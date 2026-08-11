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
 * It also states the two outcomes a chart cannot draw, because both look like an
 * empty panel: every scrape failing, and scrapes succeeding while carrying none
 * of the metrics the run asked for.
 */

import { fmtVitals } from "@/modules/dashboard/components/charts/uplot";
import type { RunReport } from "@/types";

type MonitorSection = NonNullable<RunReport["monitor"]>;

interface MonitorSummaryProps {
	monitor: MonitorSection;
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
						{stats.count} of {samples}
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

export default function MonitorSummary({ monitor }: MonitorSummaryProps) {
	const series = Object.entries(monitor.series ?? {}).sort(([a], [b]) => a.localeCompare(b));
	const attempts = monitor.samples + monitor.failures;

	return (
		<div className="space-y-3">
			{monitor.samples === 0 && monitor.failures > 0 && (
				<p className="p-3 text-sm bg-destructive/10 border border-destructive/20 text-destructive-text">
					Every scrape failed ({monitor.failures} of {attempts}). Nothing was recorded, so
					there is no chart above - check that the monitor URL was reachable from the
					engine for the life of the run.
				</p>
			)}

			{monitor.samples > 0 && series.length === 0 && (
				<p className="p-3 text-sm bg-status-warning/10 border border-status-warning/20 text-warning-text">
					{monitor.samples} scrape{monitor.samples === 1 ? "" : "s"} succeeded, but none
					carried the metrics this run asked for - check the metric names against the
					endpoint&apos;s output.
				</p>
			)}

			{monitor.samples > 0 && monitor.failures > 0 && (
				<p className="text-sm text-warning-text">
					{monitor.failures} of {attempts} scrapes failed - the gaps in the chart are
					those.
				</p>
			)}

			{series.length > 0 && (
				<>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
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
						Over {monitor.samples} scrape{monitor.samples === 1 ? "" : "s"}.
					</p>
				</>
			)}
		</div>
	);
}
