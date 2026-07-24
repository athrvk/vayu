/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * History Component Types
 */

import type { RunReport, LoadTestMetrics } from "@/types";
import type { DashboardDerived } from "@/modules/dashboard/types";

export interface TabProps {
	report: RunReport;
	runId?: string;
	derived: DashboardDerived;
}

/**
 * PerformanceTab additionally receives the persisted per-tick time-series
 * (fetched once by LoadTestDetail) so it can render the latency percentile
 * chart / response-time-vs-concurrency scatter without a second query.
 */
export interface PerformanceTabProps extends TabProps {
	timeSeries: LoadTestMetrics[];
	isLoadingSeries?: boolean;
	isFetchingMore?: boolean;
	progress?: { loaded: number; total: number };
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
}
