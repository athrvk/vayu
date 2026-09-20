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
 * `supportsAccent` decides whether AppearancePanel shows the "Match system
 * accent color" toggle at all. `getAccentScheme` resolves on every platform -
 * the main process answers `accent:get` unconditionally - but it only carries
 * a non-null scheme on Windows/macOS; Linux gets `{ accentScheme: null }`
 * back. `window.electronAPI` merely existing is therefore not enough to prove
 * support, and a regression here would put a non-functional toggle in front
 * of every Linux user.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useElectronTheme } from "./useElectronTheme";
import { STORAGE_KEYS } from "@/constants/storage-keys";

function stubElectronAPI(accentScheme: string | null) {
	vi.stubGlobal("electronAPI", {
		getTheme: vi.fn().mockResolvedValue({ shouldUseDarkColors: false, themeSource: "system" }),
		setTheme: vi.fn().mockResolvedValue({ shouldUseDarkColors: false, themeSource: "system" }),
		onThemeChanged: vi.fn().mockReturnValue(() => {}),
		getAccentScheme: vi.fn().mockResolvedValue({ accentScheme }),
		onAccentSchemeChanged: vi.fn().mockReturnValue(() => {}),
	});
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useElectronTheme - accent support detection", () => {
	it("has no accent support when window.electronAPI is absent (browser preview)", async () => {
		vi.stubGlobal("electronAPI", undefined);

		const { result } = renderHook(() => useElectronTheme());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.supportsAccent).toBe(false);
	});

	it("has no accent support when the bridge resolves a null scheme (Linux)", async () => {
		stubElectronAPI(null);

		const { result } = renderHook(() => useElectronTheme());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.supportsAccent).toBe(false);
	});

	it("has accent support when the bridge resolves a real scheme (Windows/macOS)", async () => {
		stubElectronAPI("ocean");

		const { result } = renderHook(() => useElectronTheme());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.supportsAccent).toBe(true);
	});
});

describe("useElectronTheme - matching the OS accent at launch", () => {
	it("applies the fetched OS accent, not a stale stored scheme, when matching is on", async () => {
		localStorage.setItem(STORAGE_KEYS.COLOR_SCHEME, "ocean");
		localStorage.setItem(STORAGE_KEYS.MATCH_SYSTEM_ACCENT, "true");
		stubElectronAPI("forest");

		const { result } = renderHook(() => useElectronTheme());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(document.documentElement.dataset.colorScheme).toBe("forest");
		expect(result.current.colorScheme).toBe("forest");
	});

	it("keeps the stored scheme when matching is off", async () => {
		localStorage.setItem(STORAGE_KEYS.COLOR_SCHEME, "ocean");
		localStorage.setItem(STORAGE_KEYS.MATCH_SYSTEM_ACCENT, "false");
		stubElectronAPI("forest");

		const { result } = renderHook(() => useElectronTheme());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(document.documentElement.dataset.colorScheme).toBe("ocean");
		expect(result.current.colorScheme).toBe("ocean");
	});
});
