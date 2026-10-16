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
		expect(initial.profile.duration).toBe(LOAD_TEST_DEFAULTS.DURATION_S);
		expect(initial.maxInFlight).toBe("");
		expect(initial.budgets.latencyP99Ms).toBe("345");
		expect(initial.monitor.intervalMs).toBe(2000);
	});

	it("falls back to the defaults when the stored memo is not JSON", () => {
		localStorage.setItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG, "{not json");
		expect(restore().initial.profile.rps).toBe(LOAD_TEST_DEFAULTS.RPS);
	});

	it("clamps a stored number that a lowered ceiling no longer allows", () => {
		localStorage.setItem(
			STORAGE_KEYS.LAST_LOAD_TEST_CONFIG,
			JSON.stringify({ concurrency: limits.CONCURRENCY.MAX + 1 })
		);
		expect(restore().initial.profile.concurrency).toBe(limits.CONCURRENCY.MAX);
	});

	it("keeps a stored blank p99 budget blank instead of re-seeding it", () => {
		localStorage.setItem(
			STORAGE_KEYS.LAST_LOAD_TEST_CONFIG,
			JSON.stringify({ budgets: { latencyP99Ms: "" } })
		);
		expect(restore().initial.budgets.latencyP99Ms).toBe("");
	});

	it("round-trips a saved memo", () => {
		const { initial: first, save } = restore();
		const { profile, carried: _carried, ...rest } = first;
		save({ ...profile, ...rest, rps: 77, maxInFlight: 5 } satisfies SavedLoadTestConfig);
		const { initial } = restore();
		expect(initial.profile.rps).toBe(77);
		expect(initial.maxInFlight).toBe("5");
	});

	it("does not throw when storage refuses the write", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		const { initial, save } = restore();
		const { profile, carried: _carried, ...rest } = initial;
		expect(() => save({ ...profile, ...rest, maxInFlight: null })).not.toThrow();
	});

	describe("carried budgets (#2194)", () => {
		const memo = (value: Record<string, unknown>) =>
			localStorage.setItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG, JSON.stringify(value));

		it("marks the p99 as the SLO seed on a first run", () => {
			expect(restore().initial.carried).toEqual({
				fixed: { latencyP99Ms: "slo" },
				customIds: [],
			});
		});

		it("marks non-blank memo budgets and custom rows as carried from the memo", () => {
			memo({
				budgets: { latencyP99Ms: "", maxErrorRatePct: "2" },
				customBudgets: [{ id: "c1", name: "cart", stat: "p95", value: "5" }],
			});
			expect(restore().initial.carried).toEqual({
				fixed: { maxErrorRatePct: "memo" },
				customIds: ["c1"],
			});
		});

		it("round-trips the origin a Start wrote, and ignores a malformed one", () => {
			const { initial: first, save } = restore();
			const { profile, carried: _carried, ...rest } = first;
			save({
				...profile,
				...rest,
				maxInFlight: null,
				budgetsFrom: { requestName: "Orders" },
			});
			expect(restore().initial.budgetsFrom).toEqual({ requestName: "Orders" });

			memo({ budgetsFrom: { requestName: 7 } });
			expect(restore().initial.budgetsFrom).toBeUndefined();
			memo({ budgetsFrom: "Orders" });
			expect(restore().initial.budgetsFrom).toBeUndefined();
		});

		it("restores no origin from a memo that predates the field", () => {
			memo({ budgets: { latencyP99Ms: "150" } });
			expect(restore().initial.budgetsFrom).toBeUndefined();
		});
	});
});
