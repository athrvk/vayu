/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the time-series charts shade, as chart-layer bands.
 *
 * Beside `buildData.ts` rather than inside `TimeSeriesCharts.tsx`, for the same
 * reason that file exists: a module that exports components exports only
 * components, or fast refresh stops working for the whole file.
 */

import type { Anomaly, AnomalyKind } from "../../../utils/detectAnomalies";
import { hostSleepLabel } from "../../../utils/hostSleep";
import type { HostSleep } from "@/stores/host-sleep-store";
import type { ColorRole } from "./uplotTheme";
import type { Annotation } from "./UPlotChart";

/**
 * Anomaly colour by what went wrong - errors read as errors, slowness as a
 * warning. The breakpoint marker is `warning` too and they can coincide, which
 * is correct: both are saying the run degraded there, one against the SLO and
 * one against the run's own baseline.
 */
export const ANOMALY_ROLE: Record<AnomalyKind, ColorRole> = {
	latency_spike: "warning",
	error_burst: "destructive",
	throughput_drop: "warning",
	first_5xx: "destructive",
};

/**
 * Everything shaded on the time axis: the detected anomaly windows, plus the
 * host sleeps the run could not prevent.
 *
 * A sleep is drawn as an instant, not a band. Whether the engine's elapsed
 * clock advanced through a suspend is a per-platform answer, so a band drawn
 * `durationMs` wide would be a claim about the series that may be fiction; the
 * mark says where the machine went down and the label says for how long.
 *
 * Its own module is also what makes it testable: every chart calls it and none
 * of them can be read for what it produced, since uPlot draws to a canvas.
 */
export function runAnnotations(
	anomalies?: Anomaly[] | null,
	sleeps?: readonly HostSleep[] | null
): Annotation[] {
	const windows: Annotation[] = (anomalies ?? []).map((a) => ({
		startSeconds: a.startSeconds,
		endSeconds: a.endSeconds,
		label: a.label,
		role: ANOMALY_ROLE[a.kind],
	}));
	for (const sleep of sleeps ?? []) {
		windows.push({
			startSeconds: sleep.startSeconds,
			endSeconds: sleep.startSeconds,
			label: hostSleepLabel(sleep),
			role: "warning",
		});
	}
	return windows;
}
