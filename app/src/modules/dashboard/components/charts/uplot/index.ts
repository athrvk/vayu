/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Centralized chart module. Every UI that plots a time-series (or the concurrency
 * scatter / percentile distribution) imports from here, so live + history render
 * the same components. Built on the single `UPlotChart` primitive (Canvas).
 */

export { UPlotChart } from "./UPlotChart";
export type { UPlotChartProps, UPlotSeriesSpec, Marker } from "./UPlotChart";
export { CHART_SYNC } from "./syncKeys";
export {
	LatencyPercentilesChart,
	LatencyBreakdownChart,
	RequestRateChart,
	ConnectionsChart,
	ErrorRateChart,
} from "./TimeSeriesCharts";
export { ResponseTimeVsConcurrencyChart, HdrPercentileChart } from "./ScatterAndDistribution";
export { StatusCodesOverTimeChart } from "./StatusCodesOverTimeChart";
