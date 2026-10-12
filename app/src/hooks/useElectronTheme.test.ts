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
import { act, renderHook, waitFor } from "@testing-library/react";
import { useElectronTheme } from "./useElectronTheme";
import { STORAGE_KEYS } from "@/constants/storage-keys";

/** Stubs the bridge; `emitAccent` plays the main process's live accent broadcast. */
function stubElectronAPI(accentScheme: string | null) {
	let accentListener: ((data: { accentScheme: string | null }) => void) | null = null;
	vi.stubGlobal("electronAPI", {
		getTheme: vi.fn().mockResolvedValue({ shouldUseDarkColors: false, themeSource: "system" }),
		setTheme: vi.fn().mockResolvedValue({ shouldUseDarkColors: false, themeSource: "system" }),
		onThemeChanged: vi.fn().mockReturnValue(() => {}),
		getAccentScheme: vi.fn().mockResolvedValue({ accentScheme }),
		onAccentSchemeChanged: vi.fn((cb: (data: { accentScheme: string | null }) => void) => {
			accentListener = cb;
			return () => {};
		}),
	});
	return {
		emitAccent: (next: string | null) =>
			act(() => {
				accentListener?.({ accentScheme: next });
			}),
	};
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
		expect(result.current.effectiveColorScheme).toBe("forest");
		// The manual pick is not displaced (#1861).
		expect(result.current.colorScheme).toBe("ocean");
		expect(localStorage.getItem(STORAGE_KEYS.COLOR_SCHEME)).toBe("ocean");
		expect(localStorage.getItem(STORAGE_KEYS.SYSTEM_ACCENT)).toBe("forest");
	});

	it("keeps the stored scheme when the OS reports no accent (Linux)", async () => {
		localStorage.setItem(STORAGE_KEYS.COLOR_SCHEME, "ocean");
		localStorage.setItem(STORAGE_KEYS.MATCH_SYSTEM_ACCENT, "true");
		stubElectronAPI(null);

		const { result } = renderHook(() => useElectronTheme());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(document.documentElement.dataset.colorScheme).toBe("ocean");
		expect(result.current.effectiveColorScheme).toBe("ocean");
	});

	it("drops a stored OS accent the platform no longer reports", async () => {
		localStorage.setItem(STORAGE_KEYS.COLOR_SCHEME, "ocean");
		localStorage.setItem(STORAGE_KEYS.MATCH_SYSTEM_ACCENT, "true");
		localStorage.setItem(STORAGE_KEYS.SYSTEM_ACCENT, "sky");
		stubElectronAPI(null);

		const { result } = renderHook(() => useElectronTheme());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(document.documentElement.dataset.colorScheme).toBe("ocean");
		expect(localStorage.getItem(STORAGE_KEYS.SYSTEM_ACCENT)).toBeNull();
	});

	it("keeps the stored scheme when matching is off", async () => {
		localStorage.setItem(STORAGE_KEYS.COLOR_SCHEME, "ocean");
		localStorage.setItem(STORAGE_KEYS.MATCH_SYSTEM_ACCENT, "false");
		stubElectronAPI("forest");

		const { result } = renderHook(() => useElectronTheme());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(document.documentElement.dataset.colorScheme).toBe("ocean");
		expect(result.current.colorScheme).toBe("ocean");
		expect(result.current.effectiveColorScheme).toBe("ocean");
	});
});

describe("useElectronTheme - match system accent keeps the manual pick (#1861)", () => {
	const dom = () => document.documentElement.dataset.colorScheme;

	async function mountWithManualPick(osAccent: string) {
		localStorage.setItem(STORAGE_KEYS.COLOR_SCHEME, "sunset");
		const bridge = stubElectronAPI(osAccent);
		const hook = renderHook(() => useElectronTheme());
		await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
		return { ...hook, ...bridge };
	}

	it("applies the OS accent on enabling, leaves the stored pick, and returns to it on disabling", async () => {
		const { result } = await mountWithManualPick("sky");
		expect(dom()).toBe("sunset");

		act(() => result.current.setMatchAccent(true));
		await waitFor(() => expect(dom()).toBe("sky"));
		expect(localStorage.getItem(STORAGE_KEYS.COLOR_SCHEME)).toBe("sunset");
		expect(localStorage.getItem(STORAGE_KEYS.SYSTEM_ACCENT)).toBe("sky");
		expect(result.current.colorScheme).toBe("sunset");
		expect(result.current.effectiveColorScheme).toBe("sky");

		act(() => result.current.setMatchAccent(false));
		expect(dom()).toBe("sunset");
		expect(result.current.effectiveColorScheme).toBe("sunset");
	});

	it("applies and persists a live OS accent change while matching", async () => {
		const { result, emitAccent } = await mountWithManualPick("sky");
		act(() => result.current.setMatchAccent(true));
		await waitFor(() => expect(dom()).toBe("sky"));

		emitAccent("ocean");

		expect(dom()).toBe("ocean");
		expect(localStorage.getItem(STORAGE_KEYS.SYSTEM_ACCENT)).toBe("ocean");
		expect(localStorage.getItem(STORAGE_KEYS.COLOR_SCHEME)).toBe("sunset");
	});

	it("records a live OS accent change while not matching, without repainting", async () => {
		const { result, emitAccent } = await mountWithManualPick("sky");

		emitAccent("ocean");

		expect(dom()).toBe("sunset");
		expect(localStorage.getItem(STORAGE_KEYS.SYSTEM_ACCENT)).toBe("ocean");

		act(() => result.current.setMatchAccent(true));
		expect(dom()).toBe("ocean");
	});

	it("remembers a manual pick made while matching without repainting", async () => {
		const { result } = await mountWithManualPick("sky");
		act(() => result.current.setMatchAccent(true));
		await waitFor(() => expect(dom()).toBe("sky"));

		act(() => result.current.setColorScheme("forest"));

		expect(dom()).toBe("sky");
		expect(localStorage.getItem(STORAGE_KEYS.COLOR_SCHEME)).toBe("forest");
		act(() => result.current.setMatchAccent(false));
		expect(dom()).toBe("forest");
	});
});

describe("useElectronTheme - restoring the saved theme mode at launch", () => {
	// Electron's nativeTheme.themeSource is process state and starts at "system"
	// on every launch, so the bridge reports "system" no matter what was saved.
	// The stored choice has to be pushed back into the main process.
	function stubFreshLaunch() {
		const setTheme = vi.fn(async (source: string) => ({
			shouldUseDarkColors: source === "dark",
			themeSource: source,
		}));
		vi.stubGlobal("electronAPI", {
			getTheme: vi
				.fn()
				.mockResolvedValue({ shouldUseDarkColors: false, themeSource: "system" }),
			setTheme,
			onThemeChanged: vi.fn().mockReturnValue(() => {}),
			getAccentScheme: vi.fn().mockResolvedValue({ accentScheme: null }),
			onAccentSchemeChanged: vi.fn().mockReturnValue(() => {}),
		});
		return setTheme;
	}

	beforeEach(() => {
		document.documentElement.classList.remove("dark");
	});

	it.each(["dark", "light"] as const)(
		"restores a saved %s mode into the main process",
		async (saved) => {
			localStorage.setItem(STORAGE_KEYS.THEME_SOURCE, saved);
			const setTheme = stubFreshLaunch();

			const { result } = renderHook(() => useElectronTheme());

			await waitFor(() => expect(result.current.isLoading).toBe(false));
			expect(setTheme).toHaveBeenCalledWith(saved);
			expect(result.current.themeSource).toBe(saved);
			expect(result.current.isDark).toBe(saved === "dark");
			expect(document.documentElement.classList.contains("dark")).toBe(saved === "dark");
		}
	);

	it.each([
		["nothing", null],
		["an unknown value", "sepia"],
		["system, which the main process already holds", "system"],
	])("leaves the main process alone when %s is saved", async (_label, saved) => {
		if (saved !== null) localStorage.setItem(STORAGE_KEYS.THEME_SOURCE, saved);
		const setTheme = stubFreshLaunch();

		const { result } = renderHook(() => useElectronTheme());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(setTheme).not.toHaveBeenCalled();
		expect(result.current.themeSource).toBe("system");
	});
});

describe("useElectronTheme - instances share one theme (#1855)", () => {
	// Mirrors the main process: one broadcast reaches every registered listener.
	function stubBridge() {
		const themeListeners = new Set<
			(t: { shouldUseDarkColors: boolean; themeSource: string }) => void
		>();
		const unsubscribe = vi.fn();
		const onThemeChanged = vi.fn(
			(cb: (t: { shouldUseDarkColors: boolean; themeSource: string }) => void) => {
				themeListeners.add(cb);
				return () => {
					unsubscribe();
					themeListeners.delete(cb);
				};
			}
		);
		vi.stubGlobal("electronAPI", {
			getTheme: vi
				.fn()
				.mockResolvedValue({ shouldUseDarkColors: false, themeSource: "system" }),
			setTheme: vi.fn(async (source: string) => ({
				shouldUseDarkColors: source === "dark",
				themeSource: source,
			})),
			onThemeChanged,
			getAccentScheme: vi.fn().mockResolvedValue({ accentScheme: null }),
			onAccentSchemeChanged: vi.fn().mockReturnValue(() => {}),
		});
		const broadcast = (shouldUseDarkColors: boolean) =>
			act(() => {
				for (const cb of themeListeners) {
					cb({ shouldUseDarkColors, themeSource: "system" });
				}
			});
		return { onThemeChanged, unsubscribe, broadcast };
	}

	async function mountTwo() {
		const first = renderHook(() => useElectronTheme());
		const second = renderHook(() => useElectronTheme());
		await waitFor(() => expect(first.result.current.isLoading).toBe(false));
		return { first, second };
	}

	it("keeps a scheme picked on one instance when an OS theme change is broadcast", async () => {
		const { broadcast } = stubBridge();
		const { first, second } = await mountTwo();

		act(() => second.result.current.setColorScheme("sky"));
		second.unmount();
		broadcast(true);

		expect(document.documentElement.dataset.colorScheme).toBe("sky");
		expect(first.result.current.colorScheme).toBe("sky");
		expect(first.result.current.isDark).toBe(true);
	});

	it("keeps a scheme picked on one instance when another instance sets the theme mode", async () => {
		stubBridge();
		const { first, second } = await mountTwo();

		act(() => first.result.current.setColorScheme("sky"));
		await act(() => second.result.current.setTheme("dark"));

		expect(document.documentElement.dataset.colorScheme).toBe("sky");
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(first.result.current.isDark).toBe(true);
		expect(second.result.current.colorScheme).toBe("sky");
	});

	it("subscribes once however many instances are mounted, and lets go with the last", async () => {
		const { onThemeChanged, unsubscribe } = stubBridge();
		const { first, second } = await mountTwo();
		const third = renderHook(() => useElectronTheme());

		expect(onThemeChanged).toHaveBeenCalledTimes(1);

		first.unmount();
		second.unmount();
		expect(unsubscribe).not.toHaveBeenCalled();
		third.unmount();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});
