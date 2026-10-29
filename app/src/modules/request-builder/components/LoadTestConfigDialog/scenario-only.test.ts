/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { ResolvedElement } from "@/types";
import { isScenarioOnlyKind, scenarioOnlyElements, scenarioOnlyError } from "./scenario-only";

const element = (overrides: Partial<ResolvedElement> & { kind: string }): ResolvedElement => ({
	id: overrides.kind,
	enabled: true,
	config: {},
	...overrides,
});

describe("isScenarioOnlyKind", () => {
	it.each(["timer.pacing", "timer.throughput", "control.loop", "control.once", "metric.record"])(
		"flags %s",
		(kind) => expect(isScenarioOnlyKind(kind)).toBe(true)
	);

	it.each(["timer.think", "extract.json", "assert.status", "script.pre", "script.post"])(
		"lets %s through",
		(kind) => expect(isScenarioOnlyKind(kind)).toBe(false)
	);
});

describe("scenarioOnlyElements", () => {
	it("keeps only the enabled scenario-only elements, inherited ones included", () => {
		const parts = [
			element({ kind: "timer.pacing", enabled: false }),
			element({ kind: "control.loop" }),
			element({ kind: "assert.status" }),
		];

		expect(scenarioOnlyElements(parts).map((el) => el.kind)).toEqual(["control.loop"]);
	});

	it("is empty for no resolved elements", () => {
		expect(scenarioOnlyElements(undefined)).toEqual([]);
	});
});

describe("scenarioOnlyError", () => {
	it("is null with nothing to name", () => {
		expect(scenarioOnlyError([])).toBeNull();
	});

	it("names an element set on the request itself", () => {
		const error = scenarioOnlyError([
			element({
				kind: "timer.pacing",
				origin: { kind: "request", scope: "request", id: "r" },
			}),
		]);

		expect(error).toContain("timer.pacing (set on this request)");
		expect(error).toContain("Disable or remove it");
	});

	it("names the collection an element is inherited from, a folder included", () => {
		const error = scenarioOnlyError([
			element({
				kind: "timer.pacing",
				origin: { kind: "collection", scope: "collection", id: "c", name: "Checkout" },
			}),
			element({
				kind: "control.loop",
				origin: { kind: "collection", scope: "folder", id: "f", name: "Payments" },
			}),
		]);

		expect(error).toContain("timer.pacing (inherited from the collection 'Checkout')");
		expect(error).toContain("control.loop (inherited from the collection 'Payments')");
		expect(error).toContain("Disable or remove them");
	});

	it("still places an element whose origin carries no name (a folder reads as a collection)", () => {
		const error = scenarioOnlyError([
			element({
				kind: "metric.record",
				origin: { kind: "collection", scope: "folder", id: "f" },
			}),
		]);

		expect(error).toContain("metric.record (inherited from a collection)");
	});
});
