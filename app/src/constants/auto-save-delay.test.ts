/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The auto-save intervals changed from 1s/3s/5s to 5s/30s/1m.
 *
 * Two of the old values are gone, so anyone who had chosen them holds a setting
 * the picker no longer offers. Left alone, the control renders with nothing
 * selected while auto-save keeps running on the old interval - the UI and the
 * behaviour disagreeing, which is worse than either being wrong alone.
 */

import { describe, it, expect } from "vitest";
import {
	AUTO_SAVE_DELAY_OPTIONS,
	DEFAULT_AUTO_SAVE_DELAY_MS,
	nearestAutoSaveDelay,
} from "./client-settings";

describe("auto-save delay options", () => {
	it("offers 5s, 30s and 1m", () => {
		expect(AUTO_SAVE_DELAY_OPTIONS.map((o) => o.value)).toEqual([5_000, 30_000, 60_000]);
		expect(AUTO_SAVE_DELAY_OPTIONS.map((o) => o.label)).toEqual(["5s", "30s", "1m"]);
	});

	it("defaults to a value it actually offers", () => {
		// The old default was 3s, which is no longer in the list - a default that
		// is not selectable leaves the picker blank on a fresh install.
		expect(AUTO_SAVE_DELAY_OPTIONS.map((o) => o.value)).toContain(DEFAULT_AUTO_SAVE_DELAY_MS);
	});

	it("snaps a retired value to the nearest offered one", () => {
		expect(nearestAutoSaveDelay(1_000)).toBe(5_000);
		expect(nearestAutoSaveDelay(3_000)).toBe(5_000);
	});

	it("leaves a still-valid value alone", () => {
		for (const { value } of AUTO_SAVE_DELAY_OPTIONS) {
			expect(nearestAutoSaveDelay(value)).toBe(value);
		}
	});

	it("snaps by distance, not by resetting to the default", () => {
		// Resetting everything to the default would quietly halve or double
		// someone's chosen interval instead of moving it as little as possible.
		expect(nearestAutoSaveDelay(46_000)).toBe(60_000);
		expect(nearestAutoSaveDelay(20_000)).toBe(30_000);
		expect(nearestAutoSaveDelay(999_999)).toBe(60_000);
	});

	it("breaks an exact tie downwards, towards saving sooner", () => {
		// 45s is equidistant from 30s and 60s. `reduce` keeps the incumbent on a
		// tie, so the shorter interval wins - which is the right way round for a
		// save setting: erring towards saving sooner cannot lose work.
		expect(nearestAutoSaveDelay(45_000)).toBe(30_000);
	});
});
