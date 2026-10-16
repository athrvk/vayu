/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { summarise, totalRequests } from "./summary";

const base = {
	duration: 60,
	rps: 100,
	concurrency: 10,
	iterations: 1000,
	rampDuration: 30,
	startConcurrency: 1,
	stepDuration: 5,
	sloMs: 200,
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
			"exactly 1 request using 1 virtual user"
		);
	});

	it("describes the capacity search's shape, its budget and its ceiling", () => {
		const s = summarise({ ...base, mode: "capacity", startConcurrency: 4, concurrency: 256 });
		expect(s).toContain("Steps up from 4 virtual users");
		expect(s).toContain("holding each level for 5s");
		expect(s).toContain("p99 passes 200ms");
		expect(s).toContain("256 virtual users");
		// The count no field shows is exactly the count nothing can predict
		// here - how many levels the search holds is the target's answer.
		expect(s).not.toMatch(/in total/);
	});

	describe("for a collection's sequence", () => {
		const sequence = (input: Parameters<typeof summarise>[0]) =>
			summarise(input, false, "sequence");

		it("counts passes through the sequence, never requests", () => {
			const s = sequence({ ...base, mode: "iterations", iterations: 50, concurrency: 5 });
			expect(s).toBe("Runs the sequence 50 times across 5 virtual users, then stops.");
			expect(s).not.toMatch(/request/);
		});

		it("singularises the pass and the virtual user", () => {
			expect(sequence({ ...base, mode: "iterations", iterations: 1, concurrency: 1 })).toBe(
				"Runs the sequence 1 time across 1 virtual user, then stops."
			);
		});

		it("does not promise a pass count it cannot know for a timed run", () => {
			const s = sequence({ ...base, mode: "constant_concurrency", concurrency: 10 });
			expect(s).toContain("Keeps 10 virtual users walking the sequence for 60s");
			expect(s).not.toMatch(/request/);
		});

		it("reads a ramp as the single-request summary does", () => {
			expect(sequence({ ...base, mode: "ramp_up" })).toBe(
				summarise({ ...base, mode: "ramp_up" })
			);
		});
	});
});

describe("totalRequests", () => {
	it("multiplies the rate by the duration for a constant rate", () => {
		expect(totalRequests({ ...base, mode: "constant_rps" })).toBe(6000);
	});

	it("is the iteration count, whatever the rate and duration say", () => {
		expect(totalRequests({ ...base, mode: "iterations" })).toBe(1000);
	});

	it.each(["constant_concurrency", "ramp_up", "capacity"] as const)(
		"is null for %s, whose count is the target's answer",
		(mode) => {
			expect(totalRequests({ ...base, mode })).toBeNull();
		}
	);

	it("is the figure the summary states", () => {
		expect(summarise({ ...base, mode: "constant_rps" })).toContain("6,000 requests");
		expect(summarise({ ...base, mode: "iterations" })).toContain("1,000 requests");
	});
});
