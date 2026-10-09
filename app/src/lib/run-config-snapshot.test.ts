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
