/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { summarise } from "./summary";

const base = {
	duration: 60,
	rps: 100,
	concurrency: 10,
	iterations: 1000,
	rampDuration: 30,
	startConcurrency: 1,
};

describe("summarise", () => {
	it("states the total for a constant rate, which no field shows", () => {
		expect(summarise({ ...base, mode: "constant_rps" })).toContain("6,000 requests");
	});

	it("states the exact count for fixed iterations", () => {
		const s = summarise({ ...base, mode: "iterations" });
		expect(s).toContain("exactly 1,000 requests");
		// Duration is not part of this mode at all - mentioning it would be the
		// same lie the removed field told.
		expect(s).not.toMatch(/\b60s\b/);
	});

	it("refuses to estimate a count it cannot know", () => {
		// Throughput here depends on how fast the target answers.
		const s = summarise({ ...base, mode: "constant_concurrency" });
		expect(s).toContain("depend on how fast the target responds");
		expect(s).not.toMatch(/\d+,\d{3} requests/);
	});

	it("spells out that the ramp sits inside the total", () => {
		const s = summarise({ ...base, mode: "ramp_up" });
		expect(s).toContain("over 30s");
		expect(s).toContain("remaining 30s");
		expect(s).toContain("counts towards the total");
	});

	it("omits the tail when the ramp fills the whole run", () => {
		expect(summarise({ ...base, mode: "ramp_up", duration: 30 })).not.toContain("remaining");
	});

	it("withholds the estimate while a validation error is live", () => {
		// The numbers describe a run that cannot start; printing a confident
		// total would be worse than printing none.
		expect(summarise({ ...base, mode: "constant_rps" }, true)).not.toContain("in total");
	});

	it("singularises", () => {
		expect(summarise({ ...base, mode: "iterations", iterations: 1, concurrency: 1 })).toContain(
			"exactly 1 request using 1 connection"
		);
	});
});
