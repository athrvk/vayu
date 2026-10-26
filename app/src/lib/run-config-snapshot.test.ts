/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { loadConfigFromSnapshot, requestInfoFromSnapshot } from "./run-config-snapshot";

describe("loadConfigFromSnapshot", () => {
	it("copies the known keys and omits the absent ones", () => {
		expect(
			loadConfigFromSnapshot({
				mode: "constant_rps",
				duration: "60s",
				targetRps: 100,
				comment: "nightly",
				url: "https://x.test",
				httpVersion: "auto",
			})
		).toStrictEqual({
			mode: "constant_rps",
			duration: "60s",
			targetRps: 100,
			comment: "nightly",
		});
	});

	// A run an agent started is watched live too, and its dashboard names the
	// file the same way (#2051), with how it was read (#2540). Mutation check:
	// drop the data keys from `loadConfigFromSnapshot` and both cases fail.
	it("copies the data file's row count, name, hash and reading, from either shape", () => {
		const hash = "a".repeat(64);
		expect(
			loadConfigFromSnapshot({
				mode: "constant_concurrency",
				dataRowCount: 3,
				dataFileName: "users.csv",
				dataFileHash: hash,
			})
		).toStrictEqual({
			mode: "constant_concurrency",
			dataRowCount: 3,
			dataFileName: "users.csv",
			dataFileHash: hash,
			dataFileCastNumbers: false,
		});
		expect(
			loadConfigFromSnapshot({
				scenario: {
					dataRowCount: 2,
					dataFileName: "orders.csv",
					dataFileHash: hash,
					dataFileCastNumbers: true,
				},
			})
		).toStrictEqual({
			dataRowCount: 2,
			dataFileName: "orders.csv",
			dataFileHash: hash,
			dataFileCastNumbers: true,
		});
	});

	it("carries no reading for a run that named no file", () => {
		expect(loadConfigFromSnapshot({ mode: "constant_concurrency" })).not.toHaveProperty(
			"dataFileCastNumbers"
		);
	});

	// A capacity run's own SLO is what an agent-started run's breakpoint is judged
	// by (#2816). Mutation check: drop `sloMs` from `loadConfigFromSnapshot`.
	it("copies a capacity run's sloMs", () => {
		expect(loadConfigFromSnapshot({ mode: "capacity", sloMs: 50 })).toStrictEqual({
			mode: "capacity",
			sloMs: 50,
		});
	});

	// The engine stores the request body as sent, so an agent-started run's p99
	// budget is `thresholds.latencyP99Ms`; the live charts draw it (#2939).
	// Mutation check: drop `latencyP99Ms` from `loadConfigFromSnapshot`.
	it("copies the p99 budget out of the thresholds, and nothing from the other budgets", () => {
		expect(
			loadConfigFromSnapshot({
				mode: "constant_rps",
				thresholds: { latencyP99Ms: 150, maxErrorRatePct: 1 },
			})
		).toStrictEqual({ mode: "constant_rps", latencyP99Ms: 150 });
		expect(loadConfigFromSnapshot({ thresholds: { maxErrorRatePct: 1 } })).toStrictEqual({});
	});

	it("drops a thresholds block of the wrong shape", () => {
		expect(loadConfigFromSnapshot({ thresholds: null } as never)).toStrictEqual({});
		expect(
			loadConfigFromSnapshot({ thresholds: { latencyP99Ms: "150" } } as never)
		).toStrictEqual({});
	});

	it("falls back to the engine's rps key for the target rate", () => {
		expect(loadConfigFromSnapshot({ rps: 40 }).targetRps).toBe(40);
		expect(loadConfigFromSnapshot({ targetRps: 10, rps: 40 }).targetRps).toBe(10);
	});

	it("writes a bare numeric duration as seconds", () => {
		const config = loadConfigFromSnapshot({ duration: 90, rampUpDuration: 30 } as never);
		expect(config.duration).toBe("90s");
		expect(config.rampUpDuration).toBe("30s");
	});

	it("drops a value of the wrong type", () => {
		const config = loadConfigFromSnapshot({
			mode: 3,
			concurrency: "5",
			duration: null,
		} as never);
		expect(config).toStrictEqual({});
	});
});

describe("requestInfoFromSnapshot", () => {
	it("needs both the method and the url", () => {
		expect(requestInfoFromSnapshot({ method: "GET", url: "https://x.test" })).toEqual({
			method: "GET",
			url: "https://x.test",
		});
		expect(requestInfoFromSnapshot({ method: "GET" })).toBeNull();
		expect(requestInfoFromSnapshot({ url: "https://x.test" })).toBeNull();
	});
});
