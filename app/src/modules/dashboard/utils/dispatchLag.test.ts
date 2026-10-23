/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { LoadTestMetrics } from "@/types";
import {
	LAG_HOLD_SECONDS,
	dispatchStatus,
	foldLagStreak,
	isGapOpen,
	isHeld,
	isSettled,
	liveDispatchStatus,
	type DispatchStatus,
} from "./dispatchLag";

function tick(partial: Partial<LoadTestMetrics>): LoadTestMetrics {
	return {
		timestamp: 0,
		elapsed_seconds: 0,
		requests_completed: 0,
		requests_failed: 0,
		current_rps: 0,
		current_concurrency: 0,
		avg_latency_ms: 0,
		bytes_sent: 0,
		bytes_received: 0,
		...partial,
	};
}

const TICK_SECONDS = 0.5;

interface Model {
	/** Dispatches per second the target asks for. */
	rate: number;
	/** Seconds from a dispatch to its completion. */
	latencySeconds: number;
	/** Share of the windowed completions the server delivers once `saturatesAt` passes. */
	deliveredShare?: number;
	saturatesAt?: number;
}

/**
 * The ticks an open-model run would stream, built from its two cumulative
 * counters. Completions trail dispatches by the latency, so the cumulative
 * rates part by `rate x latency / elapsed` on a server that is keeping up. The
 * windowed pair covers the trailing second (the whole run before it is that
 * old), as the engine's does.
 */
function openModelTicks(model: Model, seconds: number): LoadTestMetrics[] {
	const { rate, latencySeconds, deliveredShare = 1, saturatesAt = Infinity } = model;
	const sent = (t: number) => rate * Math.max(0, t);
	const done = (t: number) => {
		const healthy = rate * Math.max(0, t - latencySeconds);
		if (t <= saturatesAt) return healthy;
		const atSaturation = rate * Math.max(0, saturatesAt - latencySeconds);
		return atSaturation + (healthy - atSaturation) * deliveredShare;
	};
	const ticks: LoadTestMetrics[] = [];
	for (let t = TICK_SECONDS; t <= seconds + 1e-9; t += TICK_SECONDS) {
		const window = Math.min(1, t);
		ticks.push(
			tick({
				elapsed_seconds: t,
				send_rate: sent(t) / t,
				throughput: done(t) / t,
				current_send_rate: (sent(t) - sent(t - window)) / window,
				current_rps: (done(t) - done(t - window)) / window,
				// The mean latency is cumulative and nonzero once a completion landed.
				avg_latency_ms: done(t) > 0 ? latencySeconds * 1000 : 0,
			})
		);
	}
	return ticks;
}

/** The status at each tick of a live run, the streak folded exactly as the store does. */
function liveStatuses(ticks: LoadTestMetrics[]): DispatchStatus[] {
	let since: number | null = null;
	return ticks.map((m) => {
		since = foldLagStreak(since, m);
		return liveDispatchStatus(m, m.elapsed_seconds, since) as DispatchStatus;
	});
}

describe("isGapOpen", () => {
	it.each([
		["a sub-1 req/s gap", 100, 99.5, false],
		["a 1 req/s gap that is under 10% of the send rate", 500, 499, false],
		["a gap over 1 req/s but under 10%", 500, 460, false],
		["a gap of both 1 req/s and 10%", 500, 450, true],
		["a 10% gap at a rate too low to clear 1 req/s", 5, 4.5, false],
		["responses ahead of sends", 100, 120, false],
	])("%s", (_name, send, received, expected) => {
		expect(isGapOpen(send, received)).toBe(expected);
	});

	it("takes the tolerance it is handed", () => {
		expect(isGapOpen(100, 95, { minGapRps: 1, minGapShare: 0 })).toBe(true);
		expect(isGapOpen(100, 95, { minGapRps: 1, minGapShare: 0.1 })).toBe(false);
	});
});

describe("isSettled", () => {
	it("is not settled before a response has landed", () => {
		expect(isSettled(30, 0)).toBe(false);
	});

	it("waits a full second and a whole mean latency", () => {
		expect(isSettled(0.9, 100)).toBe(false);
		expect(isSettled(1, 100)).toBe(true);
		expect(isSettled(1.9, 2000)).toBe(false);
		expect(isSettled(2, 2000)).toBe(true);
	});
});

describe("foldLagStreak", () => {
	const apart = (elapsed: number) =>
		tick({
			elapsed_seconds: elapsed,
			avg_latency_ms: 100,
			current_send_rate: 100,
			current_rps: 50,
		});
	const together = (elapsed: number) =>
		tick({
			elapsed_seconds: elapsed,
			avg_latency_ms: 100,
			current_send_rate: 100,
			current_rps: 100,
		});

	it("starts at the tick the gap opened and keeps that start", () => {
		const first = foldLagStreak(null, apart(2));
		expect(first).toBe(2);
		expect(foldLagStreak(first, apart(5))).toBe(2);
	});

	it("does not start before the run has settled", () => {
		const early = tick({
			elapsed_seconds: 1,
			avg_latency_ms: 3000,
			current_send_rate: 100,
			current_rps: 50,
		});
		expect(foldLagStreak(null, early)).toBeNull();
		expect(foldLagStreak(null, { ...early, elapsed_seconds: 3.5 })).toBe(3.5);
	});

	it("resets when the rates agree again", () => {
		expect(foldLagStreak(2, together(3))).toBeNull();
	});

	it("resets on a tick with no windowed send rate instead of reading the cumulative one", () => {
		const bare = tick({ elapsed_seconds: 3, send_rate: 100, throughput: 10, current_rps: 10 });
		expect(foldLagStreak(2, bare)).toBeNull();
	});
});

describe("isHeld", () => {
	it("needs a streak that has lasted the hold", () => {
		expect(isHeld(null, 100)).toBe(false);
		expect(isHeld(2, 2 + LAG_HOLD_SECONDS - 0.1)).toBe(false);
		expect(isHeld(2, 2 + LAG_HOLD_SECONDS)).toBe(true);
	});
});

describe("dispatchStatus", () => {
	const open = { sendRate: 100, receivedRate: 50 };

	it("draws no chip without both rates", () => {
		expect(dispatchStatus({ sendRate: 100, held: true, settled: true })).toBeUndefined();
		expect(dispatchStatus({ receivedRate: 100, held: true, settled: true })).toBeUndefined();
	});

	it("stays settling until the run has settled, however wide the gap", () => {
		expect(dispatchStatus({ ...open, held: true, settled: false })).toBe("settling");
	});

	it("stays settling while an open gap has not been held", () => {
		expect(dispatchStatus({ ...open, held: false, settled: true })).toBe("settling");
	});

	it("is lagging for an open gap that was held", () => {
		expect(dispatchStatus({ ...open, held: true, settled: true })).toBe("lagging");
	});

	it("is kept-pace for a closed gap, held or not", () => {
		const closed = { sendRate: 100, receivedRate: 99.5, settled: true };
		expect(dispatchStatus({ ...closed, held: false })).toBe("kept-pace");
		expect(dispatchStatus({ ...closed, held: true })).toBe("kept-pace");
	});

	it("judges the cumulative pair of a finished run by the tolerance it is handed", () => {
		const finished = { sendRate: 4500, receivedRate: 3940, held: true, settled: true };
		expect(dispatchStatus(finished)).toBe("lagging");
		expect(
			dispatchStatus({ ...finished, tolerance: { minGapRps: 1000, minGapShare: 0 } })
		).toBe("kept-pace");
	});
});

describe("the live chip on a healthy open-model run (100 ms target)", () => {
	it.each([50, 500])("never reads lagging at %i req/s", (rate) => {
		const ticks = openModelTicks({ rate, latencySeconds: 0.1 }, 60);
		const statuses = liveStatuses(ticks);

		expect(statuses).not.toContain("lagging");
		// Past the settling seconds the chip is green, not stuck grey.
		expect(statuses[statuses.length - 1]).toBe("kept-pace");
	});

	it("would have read red on the cumulative pair, which is what the fixture is for", () => {
		// The old rule: red when cumulative send - throughput >= 1 req/s. At 500
		// req/s the gap is rate x latency / elapsed = 50 / elapsed, over 1 until 50 s.
		const ticks = openModelTicks({ rate: 500, latencySeconds: 0.1 }, 60);
		const redSeconds = ticks.filter(
			(m) => Math.max(0, (m.send_rate ?? 0) - (m.throughput ?? 0)) >= 1
		);

		expect(redSeconds[redSeconds.length - 1]?.elapsed_seconds).toBeGreaterThan(45);
		// The first five seconds are the ones the model is pinned on.
		expect(
			ticks
				.filter((m) => m.elapsed_seconds <= 5)
				.every((m) => (m.send_rate ?? 0) - (m.throughput ?? 0) >= 1)
		).toBe(true);
	});

	it("is grey, not green, while responses have had no time to trail the sends", () => {
		const ticks = openModelTicks({ rate: 500, latencySeconds: 0.1 }, 3);

		expect(liveStatuses(ticks)[0]).toBe("settling");
	});
});

describe("the live chip on a saturating run", () => {
	it("turns lagging once windowed completions have stayed 30% under sends for the hold", () => {
		// Healthy for 5 s, then the server delivers 70% of the dispatches.
		const ticks = openModelTicks(
			{ rate: 100, latencySeconds: 0.1, deliveredShare: 0.7, saturatesAt: 5 },
			20
		);
		const statuses = liveStatuses(ticks);
		const firstLagging = ticks[statuses.indexOf("lagging")];

		expect(firstLagging).toBeDefined();
		// The windowed gap opens within a second of the server falling behind, and
		// the chip must wait the hold out before it says so.
		expect(firstLagging.elapsed_seconds).toBeGreaterThanOrEqual(5 + LAG_HOLD_SECONDS);
		expect(firstLagging.elapsed_seconds).toBeLessThanOrEqual(5 + LAG_HOLD_SECONDS + 1);
		// And from there it stays lagging.
		expect(new Set(statuses.slice(statuses.indexOf("lagging")))).toEqual(new Set(["lagging"]));
		// Before that it is not red: grey while the gap is open but young.
		expect(statuses.slice(0, statuses.indexOf("lagging"))).not.toContain("lagging");
	});

	it("falls back to kept-pace once the server recovers", () => {
		const lagging = openModelTicks(
			{ rate: 100, latencySeconds: 0.1, deliveredShare: 0.7, saturatesAt: 5 },
			12
		);
		let since: number | null = null;
		for (const m of lagging) since = foldLagStreak(since, m);
		expect(isHeld(since, 12)).toBe(true);

		const recovered = tick({
			elapsed_seconds: 12.5,
			current_send_rate: 100,
			current_rps: 99,
			avg_latency_ms: 100,
		});
		since = foldLagStreak(since, recovered);
		expect(liveDispatchStatus(recovered, recovered.elapsed_seconds, since)).toBe("kept-pace");
	});
});
