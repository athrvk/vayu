/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useState, type Dispatch, type SetStateAction } from "react";
import { Input, Label, Textarea, ToggleGroup, ToggleGroupItem } from "@/components/ui";
import { NumberField } from "@/components/shared";
import { MONITOR_INTERVAL_MS } from "@/constants/monitor";
import { DisclosureCard } from "./DisclosureCard";
import type { MonitorDraft } from "./monitor";

interface MonitoringSectionProps {
	monitor: MonitorDraft;
	onMonitorChange: Dispatch<SetStateAction<MonitorDraft>>;
	/** The engine's `monitorMaxSeries` setting, shown beside the metric list. */
	maxSeries: number;
}

/**
 * Last of the three disclosures because it is about the *target* rather than
 * about the load: a run is fully specified without it, and it adds a second
 * series to the charts rather than changing what is sent.
 */
export function MonitoringSection({ monitor, onMonitorChange, maxSeries }: MonitoringSectionProps) {
	const [open, setOpen] = useState(false);

	return (
		<DisclosureCard open={open} onOpenChange={setOpen} title="Server monitoring">
			<p className="text-label leading-relaxed text-muted-foreground">
				Scrape the target&apos;s own metrics during the run and chart them on the same
				timeline as p99 and throughput - so a climb in latency can be read against the
				server&apos;s CPU or memory. Leave the URL blank to run without it.
			</p>
			<div className="space-y-1.5">
				<Label htmlFor="lt-monitor-url" className="text-xs">
					Metrics endpoint
					<span className="ml-1 font-normal text-muted-foreground">(optional)</span>
				</Label>
				<Input
					id="lt-monitor-url"
					type="text"
					value={monitor.url}
					onChange={(e) => onMonitorChange((prev) => ({ ...prev, url: e.target.value }))}
					placeholder="http://localhost:9100/metrics"
					className="text-sm"
				/>
			</div>

			<NumberField
				id="lt-monitor-interval"
				label="Scrape interval"
				unit="ms"
				value={monitor.intervalMs}
				onChange={(raw) =>
					onMonitorChange((prev) => ({ ...prev, intervalMs: Number(raw) }))
				}
				min={MONITOR_INTERVAL_MS.MIN}
				max={MONITOR_INTERVAL_MS.MAX}
				hint="Each scrape is one request to the endpoint, on its own thread - it never delays the run's own metrics."
			/>

			<div className="space-y-1.5">
				<Label className="text-xs">Response format</Label>
				{/*
				    A segmented control rather than a two-row select: it is a binary
				    choice, and `ToggleGroup` is the app's primitive for one (roving
				    focus and the `data-[state=]` variants come with it).
				 */}
				<ToggleGroup
					size="sm"
					value={monitor.format}
					onValueChange={(value) => {
						// Radix emits "" when the active item is clicked again; a format
						// is not optional, so that deselection is ignored rather than
						// leaving the draft with no format at all.
						if (value === "prometheus" || value === "json") {
							onMonitorChange((prev) => ({ ...prev, format: value }));
						}
					}}
				>
					<ToggleGroupItem value="prometheus">Prometheus text</ToggleGroupItem>
					<ToggleGroupItem value="json">Flat JSON</ToggleGroupItem>
				</ToggleGroup>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="lt-monitor-series" className="text-xs">
					Metrics to chart
					<span className="ml-1.5 font-normal text-muted-foreground">
						one name per line, up to {maxSeries}
					</span>
				</Label>
				<Textarea
					id="lt-monitor-series"
					value={monitor.series}
					onChange={(e) =>
						onMonitorChange((prev) => ({ ...prev, series: e.target.value }))
					}
					rows={3}
					placeholder={"node_cpu_seconds_total\nprocess_resident_memory_bytes"}
					className="font-mono text-xs"
				/>
				<p className="text-label text-muted-foreground">
					Names only: a Prometheus name is matched across all its labels and the values
					summed, so a whole family charts as one line and a label filter such as{" "}
					<span className="font-mono">{'{code="500"}'}</span> is not accepted.
				</p>
			</div>
		</DisclosureCard>
	);
}
