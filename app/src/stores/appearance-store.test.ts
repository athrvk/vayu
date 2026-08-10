/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The scale setting is seeded from localStorage at module load, which is the
 * only place the three legacy preset names are still read. A user who chose
 * "Comfortable" before the range existed must come back at 110%, not 100%.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { STORAGE_KEYS } from "@/constants/storage-keys";

/** Re-import the store with a given value already in localStorage. */
async function loadWithStoredScale(stored: string | null) {
	localStorage.clear();
	if (stored !== null) localStorage.setItem(STORAGE_KEYS.UI_SCALE, stored);
	vi.resetModules();
	const { useAppearanceStore } = await import("./appearance-store");
	return useAppearanceStore;
}

beforeEach(() => {
	vi.stubGlobal("electronAPI", undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("appearance store - scale seeding", () => {
	it.each([
		["compact", 0.9],
		["default", 1],
		["comfortable", 1.1],
	])("migrates the legacy %s preset to %s", async (stored, expected) => {
		const store = await loadWithStoredScale(stored);
		expect(store.getState().scale).toBe(expected);
	});

	it("reads a stored factor back verbatim", async () => {
		const store = await loadWithStoredScale("1.5");
		expect(store.getState().scale).toBe(1.5);
	});

	it("falls back to 100% for garbage and for nothing stored", async () => {
		expect((await loadWithStoredScale("banana")).getState().scale).toBe(1);
		expect((await loadWithStoredScale(null)).getState().scale).toBe(1);
	});
});

describe("appearance store - setScale", () => {
	it("clamps out-of-range input rather than storing it", async () => {
		const store = await loadWithStoredScale(null);
		store.getState().setScale(99);
		expect(store.getState().scale).toBe(2);
		expect(localStorage.getItem(STORAGE_KEYS.UI_SCALE)).toBe("2");
	});

	it("falls back to the CSS zoom fallback outside Electron", async () => {
		const store = await loadWithStoredScale(null);
		store.getState().setScale(1.3);
		expect(document.documentElement.style.zoom).toBe("1.3");
	});
});
