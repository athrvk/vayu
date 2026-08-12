/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DashboardPanel
 *
 * Behavioral preferences for live test dashboards and charts, in two topics:
 * the live charts (retention window, time granularity, refresh rate) and
 * capacity (the SLO threshold that drives breakpoint/saturation). Client-side
 * only (localStorage-backed); consumed by the charts, the dashboard store, and
 * the live metrics service.
 */

import { History, Gauge } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Eyebrow,
} from "@/components/ui";
import { useLiveChartSettings } from "@/hooks/useLiveChartSettings";
import { useClientSettingsStore } from "@/stores";
import { LIVE_WINDOW_OPTIONS } from "@/constants/live-window";
import {
	CHART_GRANULARITY_OPTIONS,
	DEFAULT_SLO_THRESHOLD_MS,
	LIVE_REFRESH_OPTIONS,
	SLO_THRESHOLD_MIN_MS,
	SLO_THRESHOLD_MAX_MS,
} from "@/constants/client-settings";
import { NumberSettingRow, OptionButtons } from "./SettingControls";

export default function DashboardPanel() {
	const { window: liveWindow, setWindow: setLiveWindow } = useLiveChartSettings();
	const sloThresholdMs = useClientSettingsStore((s) => s.sloThresholdMs);
	const setSloThresholdMs = useClientSettingsStore((s) => s.setSloThresholdMs);
	const chartBucketSeconds = useClientSettingsStore((s) => s.chartBucketSeconds);
	const setChartBucketSeconds = useClientSettingsStore((s) => s.setChartBucketSeconds);
	const liveRefreshMs = useClientSettingsStore((s) => s.liveRefreshMs);
	const setLiveRefreshMs = useClientSettingsStore((s) => s.setLiveRefreshMs);

	return (
		<>
			{/* One card per topic, settings as rows inside it. This was four cards,
			    one per setting, which made a card mean nothing. */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<History className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Live charts</CardTitle>
					</div>
					<CardDescription>
						How the charts behave while a run is in flight. Completed runs in History
						always show the full run at full detail.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<div>
						<Eyebrow className="mb-2">Chart window</Eyebrow>
						<OptionButtons
							options={LIVE_WINDOW_OPTIONS.map((o) => ({
								value: o.value,
								label: o.label,
							}))}
							value={liveWindow}
							onChange={setLiveWindow}
							columns="grid-cols-5"
						/>
						<p className="text-xs text-muted-foreground mt-2">
							How much recent history the live charts keep. Older data rolls off.
						</p>
					</div>

					<div>
						<Eyebrow className="mb-2">Chart granularity</Eyebrow>
						<OptionButtons
							options={CHART_GRANULARITY_OPTIONS}
							value={chartBucketSeconds}
							onChange={setChartBucketSeconds}
							columns="grid-cols-3"
						/>
						<p className="text-xs text-muted-foreground mt-2">
							Time-bucket width for the charts. Finer shows more detail; coarser
							smooths noisy runs.
						</p>
					</div>

					<div>
						<Eyebrow className="mb-2">Live refresh rate</Eyebrow>
						<OptionButtons
							options={LIVE_REFRESH_OPTIONS}
							value={liveRefreshMs}
							onChange={setLiveRefreshMs}
							columns="grid-cols-3"
						/>
						<p className="text-xs text-muted-foreground mt-2">
							How often live metrics are committed to the charts during a run. Faster
							is smoother; slower is lighter on the CPU.
						</p>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Gauge className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Capacity</CardTitle>
					</div>
					<CardDescription>
						What Vayu treats as the edge of a target&apos;s capacity.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<NumberSettingRow
						label="SLO threshold"
						description="The p99 latency at which a run is considered saturated. It marks the breakpoint stat, the Saturation card, and the SLO line on the latency charts, and prefills the p99 budget and the Capacity Discovery target when you open the load-test dialog."
						value={String(sloThresholdMs)}
						commit="change"
						onCommit={(next) => setSloThresholdMs(parseInt(next, 10))}
						unit="ms"
						min={String(SLO_THRESHOLD_MIN_MS)}
						max={String(SLO_THRESHOLD_MAX_MS)}
						rangeHint={`${SLO_THRESHOLD_MIN_MS} - ${SLO_THRESHOLD_MAX_MS} ms`}
						defaultValue={String(DEFAULT_SLO_THRESHOLD_MS)}
						onResetToDefault={() => setSloThresholdMs(DEFAULT_SLO_THRESHOLD_MS)}
					/>
				</CardContent>
			</Card>
		</>
	);
}
