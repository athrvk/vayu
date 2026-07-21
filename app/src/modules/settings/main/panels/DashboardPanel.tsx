/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DashboardPanel
 *
 * Behavioral preferences for live test dashboards and charts: the live chart
 * retention window, the capacity SLO threshold (drives breakpoint/saturation),
 * chart time granularity, and the live refresh rate. Client-side only
 * (localStorage-backed); consumed by the charts, the dashboard store, and the
 * live metrics service.
 */

import { History, Gauge, LineChart, Rewind } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from "@/components/ui";
import { useLiveChartWindow } from "@/hooks/useLiveChartWindow";
import { useClientSettingsStore } from "@/stores";
import { LIVE_WINDOW_OPTIONS } from "@/constants/live-window";
import {
	CHART_GRANULARITY_OPTIONS,
	LIVE_REFRESH_OPTIONS,
	SLO_THRESHOLD_MIN_MS,
	SLO_THRESHOLD_MAX_MS,
} from "@/constants/client-settings";
import { OptionButtons } from "./SettingControls";

export default function DashboardPanel() {
	const { window: liveWindow, setWindow: setLiveWindow } = useLiveChartWindow();
	const sloThresholdMs = useClientSettingsStore((s) => s.sloThresholdMs);
	const setSloThresholdMs = useClientSettingsStore((s) => s.setSloThresholdMs);
	const chartBucketSeconds = useClientSettingsStore((s) => s.chartBucketSeconds);
	const setChartBucketSeconds = useClientSettingsStore((s) => s.setChartBucketSeconds);
	const liveRefreshMs = useClientSettingsStore((s) => s.liveRefreshMs);
	const setLiveRefreshMs = useClientSettingsStore((s) => s.setLiveRefreshMs);

	return (
		<>
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<History className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Live Dashboard</CardTitle>
					</div>
					<CardDescription>
						How much recent history the live charts keep. Older data rolls off;
						completed runs in History always show the full run.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
						Chart window
					</p>
					<OptionButtons
						options={LIVE_WINDOW_OPTIONS.map((o) => ({
							value: o.value,
							label: o.label,
						}))}
						value={liveWindow}
						onChange={setLiveWindow}
						columns="grid-cols-5"
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Gauge className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Capacity SLO threshold</CardTitle>
					</div>
					<CardDescription>
						The p99 latency at which a run is considered saturated. Drives the
						breakpoint stat, the Saturation card, and the SLO line on the latency
						charts.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex items-center gap-2">
						<div className="relative">
							<Input
								type="number"
								// Named from the CardTitle above, which nothing links to
								// this input.
								aria-label="Capacity SLO threshold in milliseconds"
								className="max-w-[10rem] pr-9"
								value={sloThresholdMs}
								min={SLO_THRESHOLD_MIN_MS}
								max={SLO_THRESHOLD_MAX_MS}
								onChange={(e) => {
									const n = parseInt(e.target.value, 10);
									if (!Number.isNaN(n)) setSloThresholdMs(n);
								}}
							/>
							<span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
								ms
							</span>
						</div>
						<span className="text-xs text-muted-foreground">
							{SLO_THRESHOLD_MIN_MS}–{SLO_THRESHOLD_MAX_MS} ms
						</span>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<LineChart className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Chart granularity</CardTitle>
					</div>
					<CardDescription>
						Time-bucket width for the charts. Finer shows more detail; coarser smooths
						noisy runs.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<OptionButtons
						options={CHART_GRANULARITY_OPTIONS}
						value={chartBucketSeconds}
						onChange={setChartBucketSeconds}
						columns="grid-cols-3"
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Rewind className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Live refresh rate</CardTitle>
					</div>
					<CardDescription>
						How often live metrics are committed to the charts during a run. Faster is
						smoother; slower is lighter on the CPU.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<OptionButtons
						options={LIVE_REFRESH_OPTIONS}
						value={liveRefreshMs}
						onChange={setLiveRefreshMs}
						columns="grid-cols-3"
					/>
				</CardContent>
			</Card>
		</>
	);
}
