/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { latestGateFrame, liveDistributions } from "./liveDistributions";
import { LATENCY, PHASES, tick } from "./liveDistributions.testkit";

describe("latestGateFrame", () => {
	it("finds the latest gate frame when newer ticks are not gate frames", () => {
		const old = tick(1, { cumulative_latency: LATENCY });
		const gate = tick(2, { cumulative_latency: { ...LATENCY, p50Ms: 6 } });
		const history = [old, gate, tick(2.1), tick(2.2), tick(2.3)];

		expect(latestGateFrame(history)).toBe(gate);
	});

	it("counts a null distribution as a gate frame: nothing has completed yet", () => {
		const gate = tick(1, { cumulative_latency: null, cumulative_phases: null });

		expect(latestGateFrame([tick(0.9), gate, tick(1.1)])).toBe(gate);
	});

	it("is undefined before the first gate frame, and for an empty buffer", () => {
		expect(latestGateFrame([tick(0.1), tick(0.2)])).toBeUndefined();
		expect(latestGateFrame([])).toBeUndefined();
	});
});

describe("liveDistributions", () => {
	it("maps the latency distribution onto the report's shape, with the mean from the frame", () => {
		const { latency } = liveDistributions(
			tick(2, { cumulative_latency: LATENCY, avg_latency_ms: 9.5 })
		);

		expect(latency).toEqual({
			latency: {
				min: 1,
				max: 120,
				avg: 9.5,
				p50: 5,
				p75: 8,
				p90: 12,
				p95: 20,
				p99: 40,
				p999: 90,
			},
		});
	});

	it("maps each phase's mean onto the average key the waterfall reads", () => {
		const { phases } = liveDistributions(
			tick(2, { cumulative_latency: LATENCY, cumulative_phases: PHASES })
		);

		expect(phases).toEqual({
			kind: "ready",
			report: {
				timingBreakdown: {
					avgDnsMs: 0.1,
					avgConnectMs: 0.2,
					avgTlsMs: 0.3,
					avgFirstByteMs: 3.1,
					avgDownloadMs: 0.4,
				},
			},
		});
	});

	it("is waiting on a null distribution, never a drawn zero", () => {
		const out = liveDistributions(
			tick(1, { cumulative_latency: null, cumulative_phases: null })
		);

		expect(out.latency).toBeNull();
		expect(out.phases).toEqual({ kind: "waiting" });
	});

	it("is waiting before any gate frame", () => {
		const out = liveDistributions(undefined);

		expect(out.latency).toBeNull();
		expect(out.phases).toEqual({ kind: "waiting" });
	});

	it("says phase timing is off for a gate frame that carries latency but no phases", () => {
		const out = liveDistributions(tick(2, { cumulative_latency: LATENCY }));

		expect(out.latency).not.toBeNull();
		expect(out.phases).toEqual({ kind: "off" });
	});
});
