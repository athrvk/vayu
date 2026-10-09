/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Theme store
 *
 * Light/dark mode, the accent colour scheme and the "match system accent"
 * preference - and the single place the document is told about them.
 * `useElectronTheme` is the React face; the Electron `theme:changed` /
 * `accent:changed` subscriptions and the localStorage writes live here and are
 * registered once, by `attach`.
 *
 * Why a store rather than `useState` inside the hook (#1855): the hook is
 * mounted three times (the app shell, the Appearance panel, the command
 * palette). Each instance held its own copy of the scheme and re-applied it to
 * `<html>` on every `theme:changed`, so an instance that had not seen the
 * panel's pick wrote the stale scheme back over it. Here the DOM is always
 * derived from the store's current fields (`writeDocument`), so there is no
 * copy to go stale.
 *
 * Persistence is one localStorage key per preference, written by the action
 * rather than zustand's `persist`: the pre-paint script in index.html reads
 * the theme-source and colour-scheme keys before React mounts, and
 * `SETTINGS_STORAGE_KEYS` clears those two on "Reset app settings".
 * `vayu-match-system-accent` is neither yet (#1857, #1861).
 */

import { create } from "zustand";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import { DEFAULT_COLOR_SCHEME, isColorScheme, type ColorScheme } from "@/constants/color-schemes";
import type { ThemeSource } from "@/types/ui";

function isThemeSource(value: string | null): value is ThemeSource {
	return value === "system" || value === "light" || value === "dark";
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
	return window.matchMedia(DARK_QUERY).matches;
}

/** Whether `source` resolves to dark where Electron does not resolve it for us. */
function browserResolvesDark(source: ThemeSource): boolean {
	return source === "system" ? systemPrefersDark() : source === "dark";
}

interface ThemeState {
	themeSource: ThemeSource;
	colorScheme: ColorScheme;
	isDark: boolean;
	/** True until the first read of the persisted and OS state has landed. */
	isLoading: boolean;
	matchSystemAccent: boolean;
	/** Only Windows and macOS resolve an OS accent; Linux must not offer the toggle. */
	supportsAccent: boolean;

	setTheme: (source: ThemeSource) => Promise<void>;
	/** Pick a scheme by hand: applied and remembered. */
	setColorScheme: (scheme: ColorScheme) => void;
	setMatchAccent: (enabled: boolean) => void;
	/**
	 * Read the persisted and OS state, then listen for OS changes, for as long as
	 * at least one consumer holds the returned release function. Reference-counted
	 * so the three hook instances share one subscription set.
	 */
	attach: () => () => void;
}

const INITIAL_STATE = {
	themeSource: "system",
	colorScheme: DEFAULT_COLOR_SCHEME,
	isDark: false,
	isLoading: true,
	matchSystemAccent: false,
	supportsAccent: false,
} as const satisfies Partial<ThemeState>;

/**
 * The one DOM writer. Callers pass the store's own state, never a value of
 * their own: the document follows the store, not the other way round.
 */
function writeDocument(state: Pick<ThemeState, "isDark" | "colorScheme">): void {
	document.documentElement.classList.toggle("dark", state.isDark);
	document.documentElement.setAttribute("data-color-scheme", state.colorScheme);
}

function readStoredScheme(): ColorScheme {
	const raw = localStorage.getItem(STORAGE_KEYS.COLOR_SCHEME);
	return isColorScheme(raw) ? raw : DEFAULT_COLOR_SCHEME;
}

interface Resolved {
	themeSource: ThemeSource;
	isDark: boolean;
	colorScheme: ColorScheme;
	supportsAccent: boolean;
}

/** Launch state through the Electron bridge. */
async function resolveFromElectron(
	api: NonNullable<typeof window.electronAPI>,
	savedSource: string | null,
	scheme: ColorScheme,
	matchAccent: boolean
): Promise<Resolved> {
	// Both asked at once: neither answer depends on the other, and in sequence
	// the second round trip to the main process waited out the first while the
	// window was painting its first frame.
	//
	// The main process answers `accent:get` on every platform, but only resolves
	// a scheme on Windows/macOS - Linux has no OS accent colour, so accentScheme
	// comes back null there and the toggle must not appear at all.
	let [theme, accentInfo] = await Promise.all([api.getTheme(), api.getAccentScheme()]);
	// `nativeTheme.themeSource` is process state that starts at "system" on every
	// launch, so `theme` above is the default, not the user's choice. Push the
	// stored one back into the main process; it answers with the resolved colors.
	if (isThemeSource(savedSource) && savedSource !== theme.themeSource) {
		theme = await api.setTheme(savedSource);
	}
	return {
		themeSource: theme.themeSource as ThemeSource,
		isDark: theme.shouldUseDarkColors,
		// When matching is on and the OS gave us a scheme, it wins over the stored
		// value for the DOM write and the state alike (#1719).
		colorScheme: matchAccent && accentInfo.accentScheme ? accentInfo.accentScheme : scheme,
		supportsAccent: accentInfo.accentScheme !== null,
	};
}

/** Launch state without Electron: localStorage, then the browser's preference. */
function resolveFromBrowser(savedSource: string | null, scheme: ColorScheme): Resolved {
	const themeSource = isThemeSource(savedSource) ? savedSource : "system";
	return {
		themeSource,
		isDark: browserResolvesDark(themeSource),
		colorScheme: scheme,
		supportsAccent: false,
	};
}

export const useThemeStore = create<ThemeState>((set, get) => {
	/** Update the store, then bring the document in line with it. */
	const commit = (patch: Partial<ThemeState>): void => {
		set(patch);
		writeDocument(get());
	};

	const subscribeToElectron = (api: NonNullable<typeof window.electronAPI>): (() => void) => {
		const stopTheme = api.onThemeChanged((theme) => {
			commit({
				themeSource: theme.themeSource as ThemeSource,
				isDark: theme.shouldUseDarkColors,
			});
		});
		// Registered unconditionally and checked at delivery: the toggle can flip
		// after attach, and the bridge only sends where the OS has an accent.
		// A live OS change is applied, not persisted (#1861).
		const stopAccent = api.onAccentSchemeChanged((data) => {
			const { matchSystemAccent, supportsAccent } = get();
			if (data.accentScheme && matchSystemAccent && supportsAccent) {
				commit({ colorScheme: data.accentScheme });
			}
		});
		return () => {
			stopTheme();
			stopAccent();
		};
	};

	const subscribeToBrowser = (): (() => void) => {
		const query = window.matchMedia(DARK_QUERY);
		const handler = (e: MediaQueryListEvent) => {
			if (get().themeSource === "system") commit({ isDark: e.matches });
		};
		query.addEventListener("change", handler);
		return () => query.removeEventListener("change", handler);
	};

	let consumers = 0;
	let stopListening: (() => void) | null = null;
	// Bumped on teardown so an init still in flight cannot land on a store that
	// has been released (React StrictMode mounts, unmounts, mounts again).
	let epoch = 0;

	const start = async (): Promise<void> => {
		const myEpoch = ++epoch;
		set(INITIAL_STATE);

		const savedSource = localStorage.getItem(STORAGE_KEYS.THEME_SOURCE);
		const scheme = readStoredScheme();
		const matchSystemAccent = localStorage.getItem(STORAGE_KEYS.MATCH_SYSTEM_ACCENT) === "true";
		const api = window.electronAPI;

		const resolved = api
			? await resolveFromElectron(api, savedSource, scheme, matchSystemAccent)
			: resolveFromBrowser(savedSource, scheme);
		if (myEpoch !== epoch) return;

		// Listen from here, not before: an event ahead of the first read would
		// apply the default scheme over the one the pre-paint script chose.
		stopListening = api ? subscribeToElectron(api) : subscribeToBrowser();
		commit({ ...resolved, matchSystemAccent, isLoading: false });
	};

	const stop = (): void => {
		epoch++;
		stopListening?.();
		stopListening = null;
	};

	return {
		...INITIAL_STATE,

		setTheme: async (source) => {
			set({ themeSource: source });
			const api = window.electronAPI;
			const isDark = api
				? (await api.setTheme(source)).shouldUseDarkColors
				: browserResolvesDark(source);
			commit({ isDark });
			localStorage.setItem(STORAGE_KEYS.THEME_SOURCE, source);
		},

		setColorScheme: (scheme) => {
			commit({ colorScheme: scheme });
			localStorage.setItem(STORAGE_KEYS.COLOR_SCHEME, scheme);
		},

		setMatchAccent: (enabled) => {
			set({ matchSystemAccent: enabled });
			localStorage.setItem(STORAGE_KEYS.MATCH_SYSTEM_ACCENT, enabled ? "true" : "false");

			const api = window.electronAPI;
			if (!enabled || !api || !get().supportsAccent) return;
			void api.getAccentScheme().then((data) => {
				if (data.accentScheme) get().setColorScheme(data.accentScheme);
			});
		},

		attach: () => {
			if (++consumers === 1) void start();
			let released = false;
			return () => {
				if (released) return;
				released = true;
				if (--consumers === 0) stop();
			};
		},
	};
});
