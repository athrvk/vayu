/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How each pass/fail budget reads on screen, keyed by the engine's metric name,
 * which travels verbatim from `POST /runs` through the stored summary to the
 * report. A metric this build has no row for (a `custom.<name>.<stat>` budget, or
 * one a newer sidecar judges) renders under its raw key rather than vanishing
 * from a verdict whose counts include it - see {@link budgetName}.
 *
 * `label` heads a row in the budgets card; `short` is the one-word form a
 * sentence can list ("2 of 4 budgets missed: p95, throughput").
 */
export interface ThresholdMetricMeta {
	label: string;
	short: string;
	unit: string;
	/** A floor passes *above* its limit; every other budget is a ceiling. */
	floor?: boolean;
}

export const THRESHOLD_METRICS: Record<string, ThresholdMetricMeta> = {
	latencyP50Ms: { label: "p50 latency", short: "p50", unit: "ms" },
	latencyP95Ms: { label: "p95 latency", short: "p95", unit: "ms" },
	latencyP99Ms: { label: "p99 latency", short: "p99", unit: "ms" },
	maxErrorRatePct: { label: "Error rate", short: "error rate", unit: "%" },
	minThroughputRps: { label: "Throughput", short: "throughput", unit: "req/s", floor: true },
	maxAssertionFailureRatePct: {
		label: "Assertion failure rate",
		short: "assertion failures",
		unit: "%",
	},
};

/** The short name of a budget in running text; an unknown metric keeps its raw key. */
export function budgetName(metric: string): string {
	return THRESHOLD_METRICS[metric]?.short ?? metric;
}
