/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How the Samples tab orders and narrows the rows a run stored (#2212).
 *
 * Pure, so the chip definitions and the order are pinned without a DOM.
 */

import { httpStatusClass, isErrorStatus } from "@/constants/http-status";
import type { SampleResult } from "../types";

export const SAMPLE_FILTERS = ["all", "errors", "4xx", "5xx", "no-response", "slow"] as const;
export type SampleFilter = (typeof SAMPLE_FILTERS)[number];

export const SAMPLE_FILTER_LABEL: Record<SampleFilter, string> = {
	all: "All",
	errors: "Errors",
	"4xx": "4xx",
	"5xx": "5xx",
	"no-response": "No response",
	slow: "Slow",
};

/** A sample and its place in the time-ordered list, before any filter narrows it. */
export interface NumberedSample {
	/**
	 * 1-based rank by timestamp among every sample the run shows. It is the row's
	 * number on screen and its identity for expansion: a filter never renumbers
	 * a row, and unlike `sample.id` it exists on a report from an engine older
	 * than 0.15.0.
	 */
	number: number;
	sample: SampleResult;
}

/**
 * Oldest first. The sort is stable, so rows sharing a millisecond keep the
 * order the report listed them in.
 */
export function numberByTime(samples: SampleResult[]): NumberedSample[] {
	return [...samples]
		.sort((a, b) => a.timestamp - b.timestamp)
		.map((sample, index) => ({ number: index + 1, sample }));
}

/**
 * Slow is the engine's own verdict, `trace.isSlow` - a completion at or over the
 * run's `slow_threshold_ms`, stamped when it was traced - which is what the
 * dashboard's live row reads. Re-deriving it from `slowRequests.thresholdMs`
 * and `latencyMs` would be a second definition; a sample with no trace carries
 * no verdict and is not slow.
 */
export function isSlowSample(sample: SampleResult): boolean {
	return sample.trace?.isSlow === true;
}

const MATCHES: Record<SampleFilter, (sample: SampleResult) => boolean> = {
	all: () => true,
	// The renderer's copy of the engine's error definition, so this chip agrees
	// with the run's error tally and with the red icon on the row.
	errors: (sample) => isErrorStatus(sample.statusCode),
	"4xx": (sample) => httpStatusClass(sample.statusCode) === "client-error",
	"5xx": (sample) => httpStatusClass(sample.statusCode) === "server-error",
	"no-response": (sample) => httpStatusClass(sample.statusCode) === "no-response",
	slow: isSlowSample,
};

export function filterSamples(rows: NumberedSample[], filter: SampleFilter): NumberedSample[] {
	return rows.filter((row) => MATCHES[filter](row.sample));
}

/** How many of `rows` each chip would show, over the loaded rows only. */
export function countByFilter(rows: NumberedSample[]): Record<SampleFilter, number> {
	const counts = Object.fromEntries(SAMPLE_FILTERS.map((f) => [f, 0])) as Record<
		SampleFilter,
		number
	>;
	for (const { sample } of rows) {
		for (const filter of SAMPLE_FILTERS) {
			if (MATCHES[filter](sample)) counts[filter]++;
		}
	}
	return counts;
}

export function isSampleFilter(value: string): value is SampleFilter {
	return (SAMPLE_FILTERS as readonly string[]).includes(value);
}
