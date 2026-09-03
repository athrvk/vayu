/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The detector's whole value is that it stays quiet on a healthy run, so most of
 * what is pinned here is what it must NOT flag: a drifting baseline, a one-tick
 * blip, a cumulative failure count that stopped growing, a ramp winding down.
 * Each of those was a way an earlier rule would have filled a clean run with
 * events.
 */

import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import {
	detectAnomalies,
	createAnomalyDetector,
	BASELINE_TICKS,
	LATENCY_SPIKE_FACTOR,
	MIN_CONSECUTIVE_TICKS,
	MAX_ANOMALIES,
	ERROR_BURST_RATE,
	THROUGHPUT_DROP_FACTOR,
} from "./detectAnomalies";
import { detectAnomaliesFromScratch } from "./detectAnomalies.testkit";

function tick(elapsed: number, partial: Partial<LoadTestMetrics> = {}): LoadTestMetrics {
	return {
		timestamp: elapsed * 1000,
		elapsed_seconds: elapsed,
		requests_completed: 0,
		requests_failed: 0,
		current_rps: 0,
		current_concurrency: 0,
		latency_p50_ms: 0,
		latency_p95_ms: 0,
		latency_p99_ms: 0,
		avg_latency_ms: 0,
		bytes_sent: 0,
		bytes_received: 0,
		...partial,
	};
}

/**
 * A healthy run: p99 drifts mildly upward, throughput and concurrency hold, and
 * nothing fails. The drift is deliberate - a flat series would pass the 3x rule
 * even if the factor were 1, so it could not tell a working threshold from a
 * broken one.
 */
function healthyRun(ticks: number, over: (i: number) => Partial<LoadTestMetrics> = () => ({})) {
	return Array.from({ length: ticks }, (_, i) =>
		tick(i, {
			latency_p99_ms: 100 + i,
			current_rps: 500,
			current_concurrency: 50,
			requests_completed: i * 500,
			requests_failed: 0,
			...over(i),
		})
	);
}

describe("detectAnomalies - a clean run", () => {
	it("finds nothing in a run that only drifts", () => {
		expect(detectAnomalies(healthyRun(60))).toEqual([]);
	});

	it("would flag that same run at a 1x factor - so the 3x threshold is what keeps it quiet", () => {
		/*
		 * The mutation check for the test above, run forwards. The clean series is
		 * clean only *because* of the factor: its drift puts consecutive ticks
		 * above the trailing median, which is a run of hot ticks the moment the
		 * factor is loosened to 1. A flat series would pass either way and so
		 * could not tell a working threshold from a broken one.
		 */
		const p99 = healthyRun(60).map((m) => m.latency_p99_ms);
		const trailingMedian = (i: number) =>
			[...p99.slice(i - BASELINE_TICKS, i)].sort((a, b) => a - b)[BASELINE_TICKS >> 1];

		for (const i of [30, 31]) {
			expect(p99[i]).toBeGreaterThan(trailingMedian(i) * 1);
			expect(p99[i]).toBeLessThan(trailingMedian(i) * LATENCY_SPIKE_FACTOR);
		}
	});

	it("finds nothing before a baseline exists, however wild the opening ticks are", () => {
		// Every run starts with connection setup and an empty histogram; without
		// the warmup requirement the first seconds of every run are an "anomaly".
		const opening = Array.from({ length: BASELINE_TICKS }, (_, i) =>
			tick(i, { latency_p99_ms: i % 2 === 0 ? 5 : 900, current_rps: 100 })
		);
		expect(detectAnomalies(opening)).toEqual([]);
	});

	it("finds nothing in a series too short to say anything about", () => {
		expect(detectAnomalies([])).toEqual([]);
		expect(detectAnomalies([tick(0, { latency_p99_ms: 5000 })])).toEqual([]);
	});
});

describe("detectAnomalies - latency spikes", () => {
	it("reports a two-tick 4x spike as one window with its bounds and magnitude", () => {
		const run = healthyRun(40, (i) => (i === 20 || i === 21 ? { latency_p99_ms: 480 } : {}));

		const found = detectAnomalies(run).filter((a) => a.kind === "latency_spike");
		expect(found).toHaveLength(1);
		expect(found[0].startSeconds).toBe(20);
		// Ends at the last tick above the recovery factor - here the spike's own
		// second tick, since tick 22 is back at ~122ms against a ~113ms baseline.
		expect(found[0].endSeconds).toBe(21);
		// Baseline is the median of the 15 ticks before the spike (105…119 → 112),
		// frozen there rather than recomputed as the window extends.
		expect(found[0].magnitude).toBeCloseTo(480 / 112, 3);
		expect(found[0].label).toBe("p99 4.3x baseline for 1s");
	});

	it("does not report a one-tick spike", () => {
		// Mutation check: drop the MIN_CONSECUTIVE_TICKS requirement and this
		// single 4x tick becomes a window, which is the noise the rule exists to
		// suppress.
		expect(MIN_CONSECUTIVE_TICKS).toBe(2);
		const run = healthyRun(40, (i) => (i === 20 ? { latency_p99_ms: 480 } : {}));

		expect(detectAnomalies(run).filter((a) => a.kind === "latency_spike")).toEqual([]);
	});

	it("keeps a window open through a slow recovery instead of closing it at 3x", () => {
		// Ticks 20-21 open above 3x; 22-24 sit at ~2x, still degraded. One window,
		// not one window and three unreported seconds.
		const run = healthyRun(40, (i) =>
			i >= 20 && i <= 21
				? { latency_p99_ms: 480 }
				: i >= 22 && i <= 24
					? { latency_p99_ms: 230 }
					: {}
		);

		const found = detectAnomalies(run).filter((a) => a.kind === "latency_spike");
		expect(found).toHaveLength(1);
		expect(found[0].startSeconds).toBe(20);
		expect(found[0].endSeconds).toBe(24);
	});
});

describe("detectAnomalies - error bursts", () => {
	it("reads the cumulative failure counter as a rate, not as a level", () => {
		// 500 failures happened once, early; the counter carries them for the rest
		// of the run. Reading it undiffed reports every later tick as failing.
		const run = healthyRun(40, (i) => ({ requests_failed: i === 0 ? 0 : 500 }));

		expect(detectAnomalies(run).filter((a) => a.kind === "error_burst")).toEqual([]);
	});

	it("reports a burst that exceeds the threshold for two consecutive ticks", () => {
		expect(ERROR_BURST_RATE).toBe(0.01);
		// 25 of each tick's 500 completions fail across ticks 10 and 11 - 5%.
		const run = healthyRun(40, (i) => ({
			requests_failed: i < 10 ? 0 : i === 10 ? 25 : 50,
		}));

		const found = detectAnomalies(run).filter((a) => a.kind === "error_burst");
		expect(found).toHaveLength(1);
		expect(found[0].startSeconds).toBe(10);
		expect(found[0].endSeconds).toBe(11);
		expect(found[0].magnitude).toBeCloseTo(5, 1);
		expect(found[0].label).toMatch(/errors 5\.0% of requests for 1s/);
	});
});

describe("detectAnomalies - throughput drops", () => {
	it("reports a sustained drop while concurrency held", () => {
		const run = healthyRun(40, (i) => (i >= 25 && i <= 27 ? { current_rps: 200 } : {}));

		const found = detectAnomalies(run).filter((a) => a.kind === "throughput_drop");
		expect(found).toHaveLength(1);
		expect(found[0].startSeconds).toBe(25);
		expect(found[0].endSeconds).toBe(27);
		expect(found[0].label).toMatch(/throughput 40% of baseline for 2s/);
	});

	it("does not report a ramp winding down, where concurrency fell with it", () => {
		// The load was reduced; producing less throughput is the run obeying, not
		// the target failing. Without the concurrency guard every ramp_up run's
		// tail would be an anomaly.
		expect(THROUGHPUT_DROP_FACTOR).toBe(0.6);
		const run = healthyRun(40, (i) =>
			i >= 25 ? { current_rps: 200, current_concurrency: 10 } : {}
		);

		expect(detectAnomalies(run).filter((a) => a.kind === "throughput_drop")).toEqual([]);
	});
});

describe("detectAnomalies - first 5xx", () => {
	it("marks the tick the first server error appeared on, once", () => {
		const run = healthyRun(40, (i) =>
			i >= 12 ? { status_codes: { "200": i * 490, "503": (i - 11) * 10 } } : {}
		);

		const found = detectAnomalies(run).filter((a) => a.kind === "first_5xx");
		expect(found).toHaveLength(1);
		expect(found[0].startSeconds).toBe(12);
		expect(found[0].endSeconds).toBe(12);
		expect(found[0].label).toBe("first 503 response");
	});

	it("ignores a status map that carries only non-5xx codes", () => {
		const run = healthyRun(40, () => ({ status_codes: { "200": 1000, "404": 12 } }));

		expect(detectAnomalies(run).filter((a) => a.kind === "first_5xx")).toEqual([]);
	});
});

describe("detectAnomalies - the cap", () => {
	it("keeps the largest and says how many it dropped", () => {
		// 30 separate two-tick spikes of growing size, so which ones survive is
		// unambiguous.
		const spikes = 30;
		const run = healthyRun(BASELINE_TICKS + spikes * 5, (i) => {
			const nth = Math.floor((i - BASELINE_TICKS) / 5);
			const offset = (i - BASELINE_TICKS) % 5;
			if (i < BASELINE_TICKS || offset > 1) return {};
			return { latency_p99_ms: 500 + nth * 100 };
		});

		const found = detectAnomalies(run);
		expect(found).toHaveLength(MAX_ANOMALIES);
		// Spikes grow with time, so "the largest survive" is checkable by clock:
		// the ten dropped windows are the first ten, and the eleventh (at
		// BASELINE_TICKS + 10 * 5 seconds) is the earliest kept.
		expect(Math.min(...found.map((a) => a.startSeconds))).toBe(BASELINE_TICKS + 50);
		expect(found[found.length - 1].label).toMatch(/\(\+10 more\)$/);
		// Still in time order after the triage, so the list reads as a timeline.
		const times = found.map((a) => a.startSeconds);
		expect([...times].sort((a, b) => a - b)).toEqual(times);
	});
});

/*
 * The incremental detector (#1151). Two things have to hold and neither is
 * visible from the rule tests above: that it answers exactly what a from-scratch
 * pass answers for the same buffer, and that it gets there without re-deriving
 * the buffer it already derived. The first is proved by equivalence over a
 * randomized append/trim sequence, the second by counting the work - a
 * trailing-median sort and a status-map scan - that the caching exists to avoid.
 */

/** Seeded so a failure names one reproducible sequence rather than "sometimes". */
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * A run that trips every rule repeatedly, so equivalence is checked on findings
 * rather than on two empty lists agreeing.
 *
 * Degradations arrive as episodes of several ticks, not as independent per-tick
 * rolls: every rule here needs {@link MIN_CONSECUTIVE_TICKS} in a row, so a
 * coin flip per tick produces a series that is technically random and
 * practically clean.
 */
function noisyRun(ticks: number, rand: () => number): LoadTestMetrics[] {
	const out: LoadTestMetrics[] = [];
	const kinds = ["spike", "burst", "drop"] as const;
	let completed = 0;
	let failed = 0;
	let serverErrors = 0;
	let episode: (typeof kinds)[number] | null = null;
	let remaining = 0;

	for (let i = 0; i < ticks; i++) {
		if (remaining === 0) {
			episode = rand() < 0.25 ? kinds[Math.floor(rand() * kinds.length)] : null;
			remaining = 2 + Math.floor(rand() * 5);
		}
		remaining--;

		const rps = episode === "drop" ? 150 : 480 + Math.round(rand() * 40);
		completed += rps;
		if (episode === "burst") failed += Math.round(rps * 0.05);
		if (i > 60 && rand() < 0.01) serverErrors += 3;

		out.push(
			tick(i, {
				latency_p99_ms:
					episode === "spike"
						? 400 + Math.round(rand() * 300)
						: 100 + Math.round(rand() * 10),
				current_rps: rps,
				current_concurrency: 50,
				requests_completed: completed,
				requests_failed: failed,
				status_codes:
					serverErrors > 0
						? { "200": completed - serverErrors, "503": serverErrors }
						: { "200": completed },
			})
		);
	}
	return out;
}

/**
 * Replay a run through the store's own buffer discipline - append a batch, drop
 * the front past the time window, then past the hard cap - checking after every
 * commit that the detector and a from-scratch pass say the same thing.
 */
function replay(
	source: LoadTestMetrics[],
	rand: () => number,
	windowSeconds: number,
	cap: number
): { commits: number; kinds: Set<string> } {
	const detector = createAnomalyDetector();
	let buffer: LoadTestMetrics[] = [];
	let next = 0;
	let commits = 0;
	const kinds = new Set<string>();

	while (next < source.length) {
		const batch = 1 + Math.floor(rand() * 6);
		buffer = [...buffer, ...source.slice(next, next + batch)];
		next += batch;

		const cutoff = buffer[buffer.length - 1].elapsed_seconds - windowSeconds;
		let start = 0;
		while (start < buffer.length && buffer[start].elapsed_seconds < cutoff) start++;
		if (start > 0) buffer = buffer.slice(start);
		if (buffer.length > cap) buffer = buffer.slice(-cap);

		const found = detector.detect(buffer);
		expect(found).toEqual(detectAnomaliesFromScratch(buffer));
		// The one-shot has to answer the oracle too - it is what the history view
		// calls, and it is now a wrapper over the same rules.
		expect(detectAnomalies(buffer)).toEqual(found);
		for (const a of found) kinds.add(a.kind);
		commits++;
	}
	return { commits, kinds };
}

/**
 * The sorts and status-map scans one call costs. Both are what the from-scratch
 * pass spent per tick of retained history and what the detector is supposed to
 * spend per tick of *new* history, so counting them is the mutation check:
 * revert the caching and the incremental numbers rise to the from-scratch ones.
 */
function measure<T>(fn: () => T): { result: T; sorts: number; statusScans: number } {
	type SortFn = typeof Array.prototype.sort;
	const realSort = Array.prototype.sort;
	const realEntries = Object.entries;
	let sorts = 0;
	let statusScans = 0;

	Array.prototype.sort = function (this: unknown[], ...args: unknown[]) {
		sorts++;
		return Reflect.apply(realSort, this, args) as unknown[];
	} as unknown as SortFn;
	Object.entries = ((value: object) => {
		statusScans++;
		return realEntries(value);
	}) as typeof Object.entries;

	try {
		const result = fn();
		return { result, sorts, statusScans };
	} finally {
		Array.prototype.sort = realSort;
		Object.entries = realEntries;
	}
}

describe("createAnomalyDetector - the same answer as a from-scratch pass", () => {
	it("agrees over a randomized append/trim sequence on a tight window", () => {
		// A cap smaller than the run means every commit trims, so the clip path -
		// windows going quiet as the history they rested on rolls out - is the
		// common case here rather than an edge one.
		const rand = mulberry32(20260831);
		const { commits, kinds } = replay(noisyRun(900, rand), rand, 30, 40);
		expect(commits).toBeGreaterThan(100);
		// An agreement on nothing is not an agreement: the sequence has to have
		// actually produced findings of every kind for the equivalence to mean
		// anything.
		expect([...kinds].sort()).toEqual([
			"error_burst",
			"first_5xx",
			"latency_spike",
			"throughput_drop",
		]);
	});

	it("agrees over a randomized append/trim sequence on a window wide enough to hold whole windows", () => {
		const rand = mulberry32(31082026);
		const { commits, kinds } = replay(noisyRun(900, rand), rand, 200, 5000);
		expect(commits).toBeGreaterThan(100);
		expect([...kinds].sort()).toEqual([
			"error_burst",
			"first_5xx",
			"latency_spike",
			"throughput_drop",
		]);
	});

	it("falls silent for a window whose lead-in has rolled out, exactly as a rescan does", () => {
		// The spike at ticks 20-21 rests on a baseline taken from ticks 5-19. Trim
		// past those and the rule can no longer speak for it, so both the detector
		// and a rescan of the shortened buffer report nothing - a detector that
		// remembered its own finding would keep reporting it.
		const run = healthyRun(40, (i) => (i === 20 || i === 21 ? { latency_p99_ms: 480 } : {}));
		const detector = createAnomalyDetector();

		expect(detector.detect(run.slice(0, 30))).toHaveLength(1);
		const trimmed = run.slice(10, 30);
		expect(detectAnomaliesFromScratch(trimmed)).toEqual([]);
		expect(detector.detect(trimmed)).toEqual([]);
	});

	it("starts over on a buffer that is not a continuation of the last one", () => {
		// A second run, a replay, a remount: the ticks are different objects, so
		// there is no alignment to find and the answer has to come from scratch.
		const detector = createAnomalyDetector();
		detector.detect(healthyRun(40));

		const second = healthyRun(40, (i) => (i === 25 || i === 26 ? { latency_p99_ms: 500 } : {}));
		expect(detector.detect(second)).toEqual(detectAnomaliesFromScratch(second));
	});

	it("answers the same buffer twice with the same result", () => {
		// React renders twice under StrictMode, so `detect` is called twice with
		// one array; the second call must be served from the memo and not
		// re-ingest ticks the detector has already taken.
		const run = healthyRun(40, (i) => (i === 20 || i === 21 ? { latency_p99_ms: 480 } : {}));
		const detector = createAnomalyDetector();

		const first = detector.detect(run);
		const { result, sorts } = measure(() => detector.detect(run));
		expect(result).toBe(first);
		expect(sorts).toBe(0);
	});
});

describe("createAnomalyDetector - what a commit costs", () => {
	it("pays for the ticks that arrived, not for the ones it is still holding", () => {
		const run = healthyRun(1000);
		const detector = createAnomalyDetector();
		detector.detect(run.slice(0, 900));

		// Three trailing-median series (p99, rps, concurrency) over 10 new ticks,
		// plus the report's own ordering sort. The from-scratch pass below pays
		// the same three sorts for every tick it is holding - which is the whole
		// of #1151, and what reverting the per-tick cache would restore here.
		const incremental = measure(() => detector.detect(run.slice(0, 910)));
		expect(incremental.sorts).toBeLessThanOrEqual(3 * 10 + 1);

		const scratch = measure(() => detectAnomaliesFromScratch(run.slice(0, 910)));
		expect(scratch.sorts).toBeGreaterThan(3 * (910 - BASELINE_TICKS));
		expect(incremental.result).toEqual(scratch.result);
	});

	it("reads each tick's status map once, and none at all once the first 5xx is known", () => {
		const clean = healthyRun(1000);
		const detector = createAnomalyDetector();
		detector.detect(clean.slice(0, 900));

		// Ten new status maps, not nine hundred.
		expect(measure(() => detector.detect(clean.slice(0, 910))).statusScans).toBe(10);

		// Once the onset is found the rest of the run's maps are never opened.
		const dirty = healthyRun(1000, (i) => (i >= 100 ? { status_codes: { "503": 4 } } : {}));
		const known = createAnomalyDetector();
		known.detect(dirty.slice(0, 900));
		expect(measure(() => known.detect(dirty.slice(0, 910))).statusScans).toBe(0);
	});

	it("resumes the search when the tick the first 5xx landed on rolls out", () => {
		// Two separate onsets. Trim past the first and the answer becomes the
		// second - and the scan resumes at the new front rather than restarting,
		// so it re-reads nothing it had already cleared.
		const run = healthyRun(80, (i): Partial<LoadTestMetrics> =>
			i >= 20 && i < 40
				? { status_codes: { "503": 4 } }
				: i >= 60
					? { status_codes: { "500": 9 } }
					: {}
		);
		const detector = createAnomalyDetector();

		expect(detector.detect(run.slice(0, 70))[0]).toMatchObject({
			kind: "first_5xx",
			startSeconds: 20,
			label: "first 503 response",
		});

		const trimmed = run.slice(50);
		expect(detector.detect(trimmed)).toEqual(detectAnomaliesFromScratch(trimmed));
		expect(detector.detect(trimmed)[0]).toMatchObject({
			kind: "first_5xx",
			startSeconds: 60,
			label: "first 500 response",
		});
	});
});

describe("createAnomalyDetector - the edges of recognising the next buffer", () => {
	it("refuses a buffer whose head is a different tick at the same elapsed time", () => {
		// Aligning on elapsed time alone would accept this: the times line up and
		// the tail is shared, so only object identity says the head is not the tick
		// the detector already took. Ingesting it as if it were rolls the burst's
		// onset a tick early - a wrong answer, silently.
		const run = healthyRun(60, (i) => ({ requests_failed: i * 30 }));
		const detector = createAnomalyDetector();
		detector.detect(run);

		const spliced = run.slice(20);
		spliced[0] = { ...run[20], requests_failed: run[21].requests_failed };

		expect(detector.detect(spliced)).toEqual(detectAnomaliesFromScratch(spliced));
		expect(detector.detect(spliced).filter((a) => a.kind === "error_burst")[0]).toMatchObject({
			startSeconds: 22,
		});
	});

	it("refuses a buffer that shares only its first tick with the last one", () => {
		// The offset is confirmed at both ends because confirming it in full would
		// be the O(n) pass the detector exists to avoid. Sharing a head is not
		// enough: everything behind it can still be a different run's ticks, whose
		// values would then never be ingested at all.
		const run = healthyRun(60);
		const detector = createAnomalyDetector();
		detector.detect(run);

		const relabelled = [
			run[20],
			...run
				.slice(21)
				.map((m, i) => ({ ...m, latency_p99_ms: i === 20 || i === 21 ? 900 : 100 })),
		];
		expect(detector.detect(relabelled)).toEqual(detectAnomaliesFromScratch(relabelled));
		expect(detector.detect(relabelled).filter((a) => a.kind === "latency_spike")).toHaveLength(
			1
		);
	});

	it("agrees through resets, near-total trims and repeated elapsed times", () => {
		/*
		 * The replays above drive the store's ordinary discipline. This one drives
		 * what the store does at a run's edges - clearing the buffer between runs,
		 * trimming it down to a single tick, handing over ticks whose elapsed times
		 * repeat because two scrapes landed in the same second - which is where
		 * recognising the next buffer either holds or quietly reports the wrong
		 * run's windows. Sixty seeds, because these paths are reached by
		 * coincidence rather than by design.
		 */
		for (let seed = 1; seed <= 60; seed++) {
			const rand = mulberry32(seed);
			const source = noisyRun(300, rand).map((m, i, all) =>
				// Two scrapes in the same second: the search that finds the buffer's
				// new head can no longer assume elapsed times are distinct.
				i > 0 && rand() < 0.15 ? { ...m, elapsed_seconds: all[i - 1].elapsed_seconds } : m
			);

			const detector = createAnomalyDetector();
			let buffer: LoadTestMetrics[] = [];
			let next = 0;
			while (next < source.length) {
				buffer = [...buffer, ...source.slice(next, next + 1 + Math.floor(rand() * 8))];
				next += 1 + Math.floor(rand() * 8);

				const roll = rand();
				if (roll < 0.15) buffer = [];
				else if (roll < 0.3) buffer = buffer.slice(-1);
				else if (roll < 0.5) buffer = buffer.slice(Math.floor(rand() * 5));
				else if (roll < 0.6) buffer = buffer.slice(-Math.max(1, Math.floor(rand() * 25)));

				expect({ seed, next, found: detector.detect(buffer) }).toEqual({
					seed,
					next,
					found: detectAnomaliesFromScratch(buffer),
				});
			}
		}
	});

	it("does not re-walk an open recovery tail each time a trim clips the window", () => {
		/*
		 * The two costly things meeting: a window still open at the buffer's end,
		 * and a trim clipping its start a tick at a time as it ages out. The clip
		 * moves the baseline the window is frozen against, so the walk cannot just
		 * be kept - but it can be re-justified, because the walk recorded the
		 * lowest p99 it accepted and a threshold still under that takes no tick
		 * back out. Without that, every one of these commits re-read the whole
		 * tail: measured at ~2,000 reads each across six consecutive commits.
		 */
		const source = Array.from({ length: 2040 }, (_, i) =>
			tick(i, {
				latency_p99_ms: i < 20 ? 100 : i < 30 ? 600 : 250,
				current_rps: 500,
				current_concurrency: 50,
				requests_completed: i * 500,
			})
		);
		let p99Reads = 0;
		const run = source.map((m) => ({
			...m,
			get latency_p99_ms() {
				p99Reads++;
				return m.latency_p99_ms;
			},
		}));

		const detector = createAnomalyDetector();
		const open = detector.detect(run).filter((a) => a.kind === "latency_spike");
		// The window is open at the buffer's end, so there is a tail to re-walk.
		expect(open).toHaveLength(1);
		expect(open[0].endSeconds).toBe(2039);

		let worst = 0;
		for (let dropped = 1; dropped <= 12; dropped++) {
			const buffer = run.slice(dropped);
			p99Reads = 0;
			const found = detector.detect(buffer);
			worst = Math.max(worst, p99Reads);
			expect(found).toEqual(detectAnomaliesFromScratch(buffer));
		}
		// Bounded by the hot span the clip is eating through, not by the tail.
		expect(worst).toBeLessThan(50);
	});

	it("re-walks the tail when a clip does move the baseline the window is frozen against", () => {
		/*
		 * The other half of the clip: an escalating spike - each tick several times
		 * the last, the shape of a system going over rather than wobbling - stays
		 * hot long enough that its own ticks reach the trailing median. Once they
		 * do, clipping the start moves the frozen baseline, the recovery threshold
		 * moves with it, and a tail walked against the old one is no longer the
		 * window. Keeping it would report a degradation running to the end of the
		 * buffer that ended twenty seconds ago.
		 */
		const run = Array.from({ length: 80 }, (_, i) =>
			tick(i, {
				latency_p99_ms: i < 20 ? 100 : i < 35 ? 100 * 4 ** (i - 19) : 300,
				current_rps: 500,
				current_concurrency: 50,
				requests_completed: i * 500,
			})
		);
		const detector = createAnomalyDetector();

		const before = detector.detect(run).filter((a) => a.kind === "latency_spike");
		expect(before).toHaveLength(1);
		// Against the pre-spike baseline of 100 the 300ms plateau clears the 1.5x
		// recovery threshold, so the window runs to the end of the buffer.
		expect(before[0]).toMatchObject({ startSeconds: 20, endSeconds: 79 });

		// Clip far enough in that the spike's own ticks are the trailing median.
		const trimmed = run.slice(13);
		const after = detector.detect(trimmed);
		expect(after).toEqual(detectAnomaliesFromScratch(trimmed));
		// The baseline moved off 100, so the plateau no longer clears the threshold
		// and the window ends with the spike instead of running on.
		expect(after.filter((a) => a.kind === "latency_spike")[0].endSeconds).toBeLessThan(79);
	});

	it("walks an open recovery tail once, not once per commit", () => {
		/*
		 * A degradation that opens and then stalls above the recovery factor keeps
		 * its window open for the rest of the run, so the tail is the one thing in
		 * the detector that grows without bound while a commit is being served.
		 * It has to be resumed from where the last commit left it; restarting it at
		 * the run's end would re-read the whole tail twice a second, which is the
		 * shape of the cost #1151 is about.
		 */
		// Flat at 100ms, 6x for two ticks at t=100, then stalled at 2.5x forever:
		// the window opens and never closes, and the risen baseline behind it keeps
		// any second window from opening.
		const source = Array.from({ length: 800 }, (_, i) =>
			tick(i, {
				latency_p99_ms: i < 100 ? 100 : i < 102 ? 600 : 250,
				current_rps: 500,
				current_concurrency: 50,
				requests_completed: i * 500,
			})
		);
		let p99Reads = 0;
		const run = source.map((m) => ({
			...m,
			get latency_p99_ms() {
				p99Reads++;
				return m.latency_p99_ms;
			},
		}));

		const detector = createAnomalyDetector();
		const held = run.slice(0, 700);
		const open = detector.detect(held).filter((a) => a.kind === "latency_spike");
		// The window really is still open at the buffer's end - otherwise there is
		// no tail for the assertion below to be about.
		expect(open).toHaveLength(1);
		expect(open[0].endSeconds).toBe(699);

		p99Reads = 0;
		detector.detect(run.slice(0, 710));
		// Ten new ticks: a trailing median reads BASELINE_TICKS values each, the
		// rule reads one more, and the tail advances by ten. Restarting the tail
		// at the run's end instead would add ~600 reads on top.
		expect(p99Reads).toBeLessThan(10 * (BASELINE_TICKS + 2) + 50);
	});
});
