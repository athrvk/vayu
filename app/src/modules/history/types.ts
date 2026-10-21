/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * History Component Types
 */

import type { Run, RunReport, LoadTestMetrics, MonitorSample } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";
import type { Anomaly } from "@/modules/dashboard/utils/detectAnomalies";

/**
 * The sentence-case name a run type goes by wherever the app says it: a header,
 * a filter option, a tab title, an accessible name, the palette subtitle, the
 * History breadcrumb. The one table - `types.test.ts` fails on a second one.
 * `design` is the wire value for a single send and stays so; the user never sees
 * that word.
 */
export const RUN_TYPE_NAME: Record<Run["type"], string> = {
	design: "Send",
	scenario: "Collection run",
	load: "Load test",
};

export interface TabProps {
	report: RunReport;
	runId?: string;
	derived: DashboardDerived;
	/**
	 * Degradation windows detected in the run's per-tick series, derived once by
	 * `LoadTestDetail`. Overview states them in words, Performance shades them on
	 * the charts - one detection, two readings of it. Absent for a run whose
	 * series never loaded or that had none.
	 */
	anomalies?: Anomaly[];
}

/**
 * A failed series fetch (the time series, or the server-vitals series), with
 * the action that re-runs it, so the charts section only offers it.
 */
export interface SeriesFailure {
	message: string;
	retry: () => void;
}

/**
 * PerformanceTab additionally receives the persisted time-series, raw or
 * downsampled (fetched once by LoadTestDetail), so it can render the latency percentile
 * chart / response-time-vs-concurrency scatter without a second query.
 */
export interface PerformanceTabProps extends TabProps {
	timeSeries: LoadTestMetrics[];
	/** Set when fetching the series failed; absent while it is healthy. */
	seriesFailure?: SeriesFailure;
	/** Server vitals scraped during the run; empty when it monitored nothing. */
	monitorSamples: MonitorSample[];
	/** Set when fetching the server-vitals series failed; absent while it is healthy. */
	monitorFailure?: SeriesFailure;
	isLoadingSeries?: boolean;
	/** Stored ticks folded into each point of `timeSeries`; absent when it is raw. */
	ticksPerBucket?: number;
	/** Scrapes folded into each point of `monitorSamples`; absent when they are raw. */
	monitorTicksPerBucket?: number;
}

export interface LoadTestDetailProps {
	report: RunReport;
	runId: string;
}

/**
 * One sampled request/response outcome from a run report. Derived from the
 * domain type (`RunReport.results[]`) rather than restated, so a field added to
 * the engine's trace surfaces here without a hand-edit. The element type carries
 * the shared {@link RunResultTrace} (`*Ms` phase fields, like all timing).
 */
export type SampleResult = NonNullable<RunReport["results"]>[number];

/**
 * Time-series metrics response from GET /runs/:runId/metrics
 */
export interface TimeSeriesResponse {
	data: LoadTestMetrics[];
	pagination: {
		total: number;
		limit: number;
		offset: number;
		hasMore: boolean;
		returned: number;
	};
	/**
	 * Present only on a `maxPoints` request (#2547). `true` when the stored ticks
	 * outnumbered `maxPoints` and each entry of `data` folds `ticksPerBucket`
	 * consecutive ticks: latency percentiles, concurrency and backpressure are the
	 * bucket's max, `current_rps` its mean, everything else its last tick's
	 * (`docs/engine/api-reference.md`, "Downsampling with `maxPoints`").
	 */
	bucketed?: boolean;
	/** Ticks folded into each entry; `1` when the series already fit. */
	ticksPerBucket?: number;
}

/**
 * Server-vitals response from GET /runs/:runId/monitor - the same envelope the
 * tick series uses, so one pagination reader covers both.
 */
export interface MonitorSeriesResponse {
	data: MonitorSample[];
	pagination: {
		total: number;
		limit: number;
		offset: number;
		hasMore: boolean;
		returned: number;
	};
	/**
	 * Present only on a `maxPoints` request (#2611). `true` when the stored samples
	 * outnumbered `maxPoints` and each entry of `data` folds `ticksPerBucket`
	 * consecutive scrapes: each series is the bucket's max, the timestamp its last
	 * scrape's (`docs/engine/api-reference.md`, "Downsampling the monitor series").
	 */
	bucketed?: boolean;
	/** Scrapes folded into each entry; `1` when the series already fit. */
	ticksPerBucket?: number;
}
