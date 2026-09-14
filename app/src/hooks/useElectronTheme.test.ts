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
