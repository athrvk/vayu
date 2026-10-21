/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What History derives from a long run's downsampled series (#2547), held to
 * what it derives from the raw one.
 *
 * The breakpoint and the anomaly detector run unchanged over whatever series
 * the page has. On a bucketed series a point's p99 is its worst second and its
 * counters are as of its last, so a crossing is never missed and lands at most
 * one bucket late; the detector's tick counts then count buckets, so a window
 * it names spans at least two. Each case runs the same raw run through both
 * paths and asserts the two answers agree to within a bucket, or, for the
 * one-second spike, that they agree on naming nothing.
 *
 * Mutation check: take the bucket's last p99 in `foldLikeEngine` instead of
 * its max, as a fold that kept only last-tick values would, and the
 * one-second breakpoint case reddens.
 */

import { describe, it, expect } from "vitest";
import { computeBreakpoint } from "./computeBreakpoint";
import { detectAnomalies, type Anomaly, type AnomalyKind } from "./detectAnomalies";
import { STORED_P99_MS, foldLikeEngine, storedTicks } from "./downsample.testkit";

/** 6,000 ticks into 100 points: 60 seconds a bucket, wide enough to matter. */
const SECONDS = 6000;
const MAX_POINTS = 100;
const BUCKET = SECONDS / MAX_POINTS;
const SLO_MS = 200;

function bucketed(at: Parameters<typeof storedTicks>[1]) {
	const raw = storedTicks(SECONDS, at);
	const folded = foldLikeEngine(raw, MAX_POINTS);
	expect(folded.bucketed).toBe(true);
	expect(folded.ticksPerBucket).toBe(BUCKET);
	expect(folded.data).toHaveLength(MAX_POINTS);
	return { raw, folded: folded.data };
}

function only(anomalies: Anomaly[], kind: AnomalyKind): Anomaly {
	const found = anomalies.filter((a) => a.kind === kind);
	expect(found).toHaveLength(1);
	return found[0];
}

describe("a downsampled series against the raw one", () => {
	it("names a sustained p99 spike in both, starting within a bucket of the raw start", () => {
		const { raw, folded } = bucketed((s) => (s >= 3000 && s < 3300 ? { p99: 500 } : {}));

		const fromRaw = only(detectAnomalies(raw), "latency_spike");
		const fromFolded = only(detectAnomalies(folded), "latency_spike");

		expect(fromRaw.startSeconds).toBe(3000);
		expect(fromFolded.startSeconds).toBeGreaterThanOrEqual(fromRaw.startSeconds);
		expect(fromFolded.startSeconds).toBeLessThan(fromRaw.startSeconds + BUCKET);
		expect(fromFolded.magnitude).toBeCloseTo(fromRaw.magnitude);
	});

	it("sets the breakpoint for a one-second p99 spike in both, at most a bucket late, at the same p99", () => {
		const { raw, folded } = bucketed((s) => (s === 4321 ? { p99: 900 } : {}));

		const fromRaw = computeBreakpoint(raw, SLO_MS);
		const fromFolded = computeBreakpoint(folded, SLO_MS);

		expect(fromRaw).toMatchObject({ crossed: true, timeSeconds: 4321, p99Ms: 900 });
		expect(fromFolded).toMatchObject({ crossed: true, p99Ms: 900 });
		expect(fromFolded.timeSeconds!).toBeGreaterThanOrEqual(4321);
		expect(fromFolded.timeSeconds!).toBeLessThan(4321 + BUCKET);
		// One second is under the two ticks a window needs, raw or bucketed.
		expect(detectAnomalies(raw).filter((a) => a.kind === "latency_spike")).toEqual([]);
		expect(detectAnomalies(folded).filter((a) => a.kind === "latency_spike")).toEqual([]);
	});

	it("keeps a run that never crossed the SLO uncrossed", () => {
		const { raw, folded } = bucketed(() => ({}));

		expect(computeBreakpoint(raw, SLO_MS).crossed).toBe(false);
		expect(computeBreakpoint(folded, SLO_MS).crossed).toBe(false);
		expect(STORED_P99_MS).toBeLessThan(SLO_MS);
	});

	it("names a sustained error burst in both: the share needs no restating", () => {
		const { raw, folded } = bucketed((s) =>
			s >= 2000 && s < 2300 ? { failed: 50, status: { "200": 50, "503": 50 } } : {}
		);

		const fromRaw = only(detectAnomalies(raw), "error_burst");
		const fromFolded = only(detectAnomalies(folded), "error_burst");

		expect(fromRaw.startSeconds).toBe(2000);
		expect(fromFolded.startSeconds).toBeGreaterThanOrEqual(2000);
		expect(fromFolded.startSeconds).toBeLessThan(2000 + BUCKET);
		expect(fromFolded.magnitude).toBeCloseTo(fromRaw.magnitude);
	});

	it("puts the first 5xx on the bucket that holds it", () => {
		const { raw, folded } = bucketed((s) =>
			s === 2500 ? { failed: 1, status: { "200": 99, "500": 1 } } : {}
		);

		expect(only(detectAnomalies(raw), "first_5xx").startSeconds).toBe(2500);
		const onset = only(detectAnomalies(folded), "first_5xx").startSeconds;
		expect(onset).toBeGreaterThanOrEqual(2500);
		expect(onset).toBeLessThan(2500 + BUCKET);
	});
});
