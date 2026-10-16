/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { buildNotices, type NoticeInputs } from "./notices";

const CLEAN: NoticeInputs = {
	rampDurationError: null,
	startFloorError: null,
	startConcurrencyError: null,
	capacityRangeError: null,
	budgetsError: null,
	monitoringError: null,
	hasPreRequestScript: false,
	scriptsOverride: "asMarked",
	defaultHeaderDifference: null,
	remoteTarget: null,
};

const keys = (overrides: Partial<NoticeInputs>) =>
	buildNotices({ ...CLEAN, ...overrides }).map((n) => n.key);

describe("buildNotices", () => {
	it("raises nothing for a clean draft", () => {
		expect(keys({})).toEqual([]);
	});

	it("sorts blocking notices above the warning and the info, whatever order they were found in", () => {
		expect(
			keys({
				defaultHeaderDifference: "Accept-Encoding differs",
				hasPreRequestScript: true,
				budgetsError: "p99 is out of range",
			})
		).toEqual(["budgets", "pre-script", "default-headers"]);
	});

	it("raises the off-network advisory as info, below every blocking notice", () => {
		const remoteTarget = { host: "api.example.com", requestCount: 6000 };
		expect(keys({ remoteTarget })).toEqual(["remote-target"]);
		expect(buildNotices({ ...CLEAN, remoteTarget })[0].severity).toBe("info");
		expect(
			keys({
				remoteTarget,
				hasPreRequestScript: true,
				budgetsError: "p99 is out of range",
			})
		).toEqual(["budgets", "pre-script", "remote-target"]);
	});

	it("warns about a pre-request script at both settings that skip it", () => {
		expect(keys({ hasPreRequestScript: true, scriptsOverride: "asMarked" })).toEqual([
			"pre-script",
		]);
		expect(keys({ hasPreRequestScript: true, scriptsOverride: "allDeferred" })).toEqual([
			"pre-script",
		]);
	});

	it("drops the pre-request warning once Scripts is All inline", () => {
		expect(keys({ hasPreRequestScript: true, scriptsOverride: "allInline" })).toEqual([]);
	});

	it("says nothing about scripts when the request has no pre-request script", () => {
		expect(keys({ hasPreRequestScript: false, scriptsOverride: "asMarked" })).toEqual([]);
	});
});
