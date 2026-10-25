/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { afterAll, describe, it, expect, vi } from "vitest";

// The formatters build their Intl.NumberFormat at module load, so the locale is
// pinned before the import below runs rather than left to the host.
const restoreIntl = vi.hoisted(() => {
	const Real = Intl.NumberFormat;
	class EnUsNumberFormat extends Real {
		constructor(_locale?: string | string[], options?: Intl.NumberFormatOptions) {
			super("en-US", options);
		}
	}
	Intl.NumberFormat = EnUsNumberFormat as typeof Intl.NumberFormat;
	return () => {
		Intl.NumberFormat = Real;
	};
});

afterAll(restoreIntl);

import { capacitySubtitle, resultSubtitle } from "./result-subtitle";

/**
 * Mutation check (#2820): drop the `assertionsFailed` push in `resultSubtitle`
 * and the three assertion rows redden.
 *
 * Capacity (#2930): drop the `summary.capacity` guard in `resultSubtitle` and
 * the average-rate case reddens; make `capacitySubtitle` ignore `finding` and
 * the plateau, knee-gate and unknown-reason rows redden; print `held 0` for an
 * absent held level and the knee-only row reddens.
 */

describe("resultSubtitle", () => {
	it.each([
		[{ rps: 485.2, p95Ms: 42, errorRate: 0 }, "485 req/s · p95 42ms · 0.0% errors"],
		[{ rps: 12400, p95Ms: 1500, errorRate: 15.14 }, "12,400 req/s · p95 1.50s · 15.1% errors"],
		[{ rps: 4.25 }, "4.25 req/s"],
		[{ p95Ms: 42, errorRate: 2 }, "p95 42ms · 2.0% errors"],
		[{ errorRate: 0.01 }, "<0.1% errors"],
		[{ verdict: "passed" as const }, null],
		[{}, null],
		[
			{ rps: 485, p95Ms: 42, errorRate: 0, assertionsPassed: 10, assertionsFailed: 4580 },
			"485 req/s · p95 42ms · 0.0% errors · 4,580 assertions failed",
		],
		[{ errorRate: 0, assertionsFailed: 1 }, "0.0% errors · 1 assertion failed"],
		[{ assertionsFailed: 4580 }, "4,580 assertions failed"],
		// Zero failed is not worth a clause, and passed alone is never printed.
		[{ errorRate: 0, assertionsPassed: 10, assertionsFailed: 0 }, "0.0% errors"],
	])("%j reads %j", (summary, line) => {
		expect(resultSubtitle(summary)).toBe(line);
	});
});

describe("a capacity run's line (#2930)", () => {
	const AVERAGED = { rps: 485.2, p95Ms: 42, errorRate: 0 };

	it.each([
		// The search watched the target give out: both levels, or the knee alone.
		[
			"slo_exceeded",
			{ maxHealthyConcurrency: 41, kneeConcurrency: 51 },
			"held 41 · gave out at 51",
		],
		[
			"errors_exceeded",
			{ maxHealthyConcurrency: 41, kneeConcurrency: 51 },
			"held 41 · gave out at 51",
		],
		["slo_exceeded", { kneeConcurrency: 1 }, "gave out at 1"],
		["errors_exceeded", { kneeConcurrency: 8 }, "gave out at 8"],
		[
			"slo_exceeded",
			{ maxHealthyConcurrency: 1200, kneeConcurrency: 1500 },
			"held 1,200 · gave out at 1,500",
		],
		// A degrading stop with no knee proves only a floor.
		["slo_exceeded", { maxHealthyConcurrency: 41 }, "held at least 41"],
		// Saturation: the held level is the last one tried and overshoots the
		// plateau point, so no level is named.
		["plateau", { maxHealthyConcurrency: 64 }, "plateaued"],
		["plateau", { maxHealthyConcurrency: 64, kneeConcurrency: 80 }, "plateaued"],
		["plateau", {}, "plateaued"],
		// A bound the caller set is a floor.
		["cap_reached", { maxHealthyConcurrency: 200 }, "held at least 200"],
		["deadline", { maxHealthyConcurrency: 30 }, "held at least 30"],
		["stopped", { maxHealthyConcurrency: 12 }, "held at least 12"],
		// A reason a newer engine invented still gets the floor it can prove.
		["some_new_reason", { maxHealthyConcurrency: 7 }, "held at least 7"],
		// Nothing usable: no line, never the average rate.
		["cap_reached", {}, null],
		["deadline", {}, null],
		["stopped", {}, null],
		["some_new_reason", { kneeConcurrency: 9 }, null],
	])("%s with %j reads %j", (stopReason, levels, line) => {
		expect(capacitySubtitle({ stopReason, ...levels })).toBe(line);
	});

	it("prints the levels in place of the run-average rate", () => {
		const capacity = {
			stopReason: "slo_exceeded",
			maxHealthyConcurrency: 41,
			kneeConcurrency: 51,
		};

		expect(resultSubtitle({ ...AVERAGED, capacity })).toBe("held 41 · gave out at 51");
	});

	it("prints no line for a search with no level rather than the average rate", () => {
		expect(resultSubtitle({ ...AVERAGED, capacity: { stopReason: "stopped" } })).toBeNull();
	});

	it("keeps the average-rate line for a capacity row an older engine sent without the block", () => {
		expect(resultSubtitle(AVERAGED)).toBe("485 req/s · p95 42ms · 0.0% errors");
	});
});
