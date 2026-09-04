/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What went wrong and when - the run's detected anomaly windows, in words.
 *
 * The bands on the charts show where; this says what, because a shaded region a
 * reader has to hover is not a finding. It is deliberately the same list the
 * charts shade (one `detectAnomalies` call in `LoadTestDetail`, passed to both),
 * so the paint and the prose can never disagree.
 *
 * Silent for a clean run. An "Events (0)" card would put the reader's eye on the
 * one thing that has nothing to say.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Anomaly, AnomalyKind } from "@/modules/dashboard/utils/detectAnomalies";
import { formatSleepDuration } from "@/modules/dashboard/utils/hostSleep";
import type { HostSleep } from "@/stores/host-sleep-store";

/**
 * How each kind reads on screen. The tone follows the finding: an error burst
 * and the first 5xx are failures, a latency spike or a throughput drop is
 * degradation - the same split the chart bands use, in the text vocabulary
 * (`-text` tokens, never the bare indicator colour as a foreground).
 */
const KIND_META: Record<AnomalyKind, { label: string; tone: string }> = {
	latency_spike: { label: "Latency spike", tone: "text-warning-text" },
	error_burst: { label: "Error burst", tone: "text-destructive-text" },
	throughput_drop: { label: "Throughput drop", tone: "text-warning-text" },
	first_5xx: { label: "Server errors began", tone: "text-destructive-text" },
};

/** "41.2s" - matching the charts' 0.1s hover readout. */
function at(seconds: number): string {
	return `${seconds.toFixed(1)}s`;
}

export interface RunEventsProps {
	anomalies?: Anomaly[] | null;
	/**
	 * Intervals the host spent asleep under the run (#1357). Listed beside the
	 * detected windows because a reader looking at a flat stretch is asking the
	 * same question of both - and this is the one answer the series cannot give,
	 * since the engine was suspended too.
	 */
	sleeps?: readonly HostSleep[] | null;
	className?: string;
}

export function RunEvents({ anomalies, sleeps, className }: RunEventsProps) {
	const hostSleeps = sleeps ?? [];
	if ((!anomalies || anomalies.length === 0) && hostSleeps.length === 0) return null;

	return (
		<Card className={className}>
			<CardHeader>
				<CardTitle>Events</CardTitle>
			</CardHeader>
			<CardContent>
				<p className="mb-3 text-xs text-muted-foreground">
					Windows where the run departed from its own baseline, and any stretch the host
					spent asleep under it. Both are marked on the charts in the Performance tab.
				</p>
				<ul className="space-y-1.5">
					{hostSleeps.map((sleep) => (
						<li
							key={`host-sleep-${sleep.at}`}
							className="flex items-baseline justify-between gap-3 p-2 bg-muted rounded-md text-sm"
						>
							<span className="font-medium text-warning-text">Host asleep</span>
							<span className="flex-1 text-muted-foreground">
								The machine slept for {formatSleepDuration(sleep.durationMs)}; the
								run could not send during it
							</span>
							<span className="font-mono text-xs text-muted-foreground">
								{at(sleep.startSeconds)}
							</span>
						</li>
					))}
					{(anomalies ?? []).map((a) => (
						<li
							key={`${a.kind}-${a.startSeconds}`}
							className="flex items-baseline justify-between gap-3 p-2 bg-muted rounded-md text-sm"
						>
							<span className={cn("font-medium", KIND_META[a.kind].tone)}>
								{KIND_META[a.kind].label}
							</span>
							<span className="flex-1 text-muted-foreground">{a.label}</span>
							<span className="font-mono text-xs text-muted-foreground">
								{a.endSeconds > a.startSeconds
									? `${at(a.startSeconds)} - ${at(a.endSeconds)}`
									: at(a.startSeconds)}
							</span>
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}
