/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
	DEFAULT_LOAD_TEST_CEILINGS,
	LOAD_TEST_DEFAULTS,
	resolveLoadTestLimits,
} from "@/constants/load-test";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import { useSavedLoadTestConfig, type SavedLoadTestConfig } from "./useSavedLoadTestConfig";

const limits = resolveLoadTestLimits(DEFAULT_LOAD_TEST_CEILINGS);
const seeds = { sloThresholdMs: 345, monitorIntervalMs: 2000 };

function restore() {
	return renderHook(() => useSavedLoadTestConfig(limits, seeds)).result.current;
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("useSavedLoadTestConfig", () => {
	it("starts from the defaults and the settings seeds when nothing is stored", () => {
		const { initial } = restore();
		expect(initial.duration).toBe(LOAD_TEST_DEFAULTS.DURATION_S);
		expect(initial.maxInFlight).toBe("");
		expect(initial.budgets.latencyP99Ms).toBe("345");
		expect(initial.monitor.intervalMs).toBe(2000);
	});

	it("falls back to the defaults when the stored memo is not JSON", () => {
		localStorage.setItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG, "{not json");
		expect(restore().initial.rps).toBe(LOAD_TEST_DEFAULTS.RPS);
	});

	it("clamps a stored number that a lowered ceiling no longer allows", () => {
		localStorage.setItem(
			STORAGE_KEYS.LAST_LOAD_TEST_CONFIG,
			JSON.stringify({ concurrency: limits.CONCURRENCY.MAX + 1 })
		);
		expect(restore().initial.concurrency).toBe(limits.CONCURRENCY.MAX);
	});

	it("keeps a stored blank p99 budget blank instead of re-seeding it", () => {
		localStorage.setItem(
			STORAGE_KEYS.LAST_LOAD_TEST_CONFIG,
			JSON.stringify({ budgets: { latencyP99Ms: "" } })
		);
		expect(restore().initial.budgets.latencyP99Ms).toBe("");
	});

	it("round-trips a saved memo", () => {
		const first = restore();
		first.save({ ...first.initial, rps: 77, maxInFlight: 5 } satisfies SavedLoadTestConfig);
		const { initial } = restore();
		expect(initial.rps).toBe(77);
		expect(initial.maxInFlight).toBe("5");
	});

	it("does not throw when storage refuses the write", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		const { initial, save } = restore();
		expect(() => save({ ...initial, maxInFlight: null })).not.toThrow();
	});
});
