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
 * Two fields carry the accent, and neither overwrites the other (#1861):
 * `colorScheme` is the user's manual pick and `systemAccent` is the last scheme
 * the OS reported. The scheme on screen is derived from them
 * (`effectiveColorScheme`), so turning "match system accent" off returns to the
 * manual pick instead of to whatever the OS last said.
 *
 * Persistence is one localStorage key per preference, written by the action
 * rather than zustand's `persist`: the pre-paint script in index.html reads
 * the theme-source, colour-scheme, match-flag and system-accent keys before
 * React mounts, and `SETTINGS_STORAGE_KEYS` clears all four on "Reset app
 * settings".
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
	/** The user's manual pick. Never overwritten by the OS accent. */
	colorScheme: ColorScheme;
	/** The last scheme the OS reported: null before the first, and always on Linux. */
	systemAccent: ColorScheme | null;
	isDark: boolean;
	/** True until the first read of the persisted and OS state has landed. */
	isLoading: boolean;
	matchSystemAccent: boolean;
	/** Only Windows and macOS resolve an OS accent; Linux must not offer the toggle. */
	supportsAccent: boolean;

	setTheme: (source: ThemeSource) => Promise<void>;
	/** Pick a scheme by hand: remembered, and applied unless the OS accent is in force. */
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
	systemAccent: null,
	isDark: false,
	isLoading: true,
	matchSystemAccent: false,
	supportsAccent: false,
} as const satisfies Partial<ThemeState>;

/**
 * The scheme on screen: the OS accent while matching it and the OS has reported
 * one, the manual pick otherwise. index.html's pre-paint script applies the same
 * rule to the stored keys.
 */
export function effectiveColorScheme(
	state: Pick<ThemeState, "colorScheme" | "systemAccent" | "matchSystemAccent">
): ColorScheme {
	return state.matchSystemAccent && state.systemAccent ? state.systemAccent : state.colorScheme;
}

/**
 * The one DOM writer. Callers pass the store's own state, never a value of
 * their own: the document follows the store, not the other way round.
 */
function writeDocument(
	state: Pick<ThemeState, "isDark" | "colorScheme" | "systemAccent" | "matchSystemAccent">
): void {
	document.documentElement.classList.toggle("dark", state.isDark);
	document.documentElement.setAttribute("data-color-scheme", effectiveColorScheme(state));
}

function readStoredScheme(key: string): ColorScheme | null {
	const raw = localStorage.getItem(key);
	return isColorScheme(raw) ? raw : null;
}

interface Resolved {
	themeSource: ThemeSource;
	isDark: boolean;
	/** What the OS reports now; null where it has no accent colour or there is no OS bridge. */
	systemAccent: ColorScheme | null;
	supportsAccent: boolean;
}

/** Launch state through the Electron bridge. */
async function resolveFromElectron(
	api: NonNullable<typeof window.electronAPI>,
	savedSource: string | null
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
		systemAccent: accentInfo.accentScheme,
		supportsAccent: accentInfo.accentScheme !== null,
	};
}

/** Launch state without Electron: localStorage, then the browser's preference. */
function resolveFromBrowser(savedSource: string | null): Resolved {
	const themeSource = isThemeSource(savedSource) ? savedSource : "system";
	return {
		themeSource,
		isDark: browserResolvesDark(themeSource),
		systemAccent: null,
		supportsAccent: false,
	};
}

export const useThemeStore = create<ThemeState>((set, get) => {
	/** Update the store, then bring the document in line with it. */
	const commit = (patch: Partial<ThemeState>): void => {
		set(patch);
		writeDocument(get());
	};

	/**
	 * Remember what the OS reported, whether or not it is being matched: the
	 * pre-paint script and a later toggle both need the latest one. The document
	 * only changes if matching is on.
	 */
	const recordSystemAccent = (accent: ColorScheme): void => {
		localStorage.setItem(STORAGE_KEYS.SYSTEM_ACCENT, accent);
		commit({ systemAccent: accent });
	};

	const subscribeToElectron = (api: NonNullable<typeof window.electronAPI>): (() => void) => {
		const stopTheme = api.onThemeChanged((theme) => {
			commit({
				themeSource: theme.themeSource as ThemeSource,
				isDark: theme.shouldUseDarkColors,
			});
		});
		// Registered unconditionally: the toggle can flip after attach, and the
		// bridge only sends where the OS has an accent.
		const stopAccent = api.onAccentSchemeChanged((data) => {
			if (data.accentScheme) recordSystemAccent(data.accentScheme);
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
		const colorScheme = readStoredScheme(STORAGE_KEYS.COLOR_SCHEME) ?? DEFAULT_COLOR_SCHEME;
		const matchSystemAccent = localStorage.getItem(STORAGE_KEYS.MATCH_SYSTEM_ACCENT) === "true";
		const api = window.electronAPI;

		const resolved = api
			? await resolveFromElectron(api, savedSource)
			: resolveFromBrowser(savedSource);
		if (myEpoch !== epoch) return;

		// Listen from here, not before: an event ahead of the first read would
		// apply the default scheme over the one the pre-paint script chose.
		stopListening = api ? subscribeToElectron(api) : subscribeToBrowser();
		// The OS answer is authoritative: where it reports nothing (Linux, no
		// bridge) a stored accent from another machine must not stay in force.
		if (resolved.systemAccent)
			localStorage.setItem(STORAGE_KEYS.SYSTEM_ACCENT, resolved.systemAccent);
		else localStorage.removeItem(STORAGE_KEYS.SYSTEM_ACCENT);
		commit({
			...resolved,
			colorScheme,
			matchSystemAccent,
			isLoading: false,
		});
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
			localStorage.setItem(STORAGE_KEYS.MATCH_SYSTEM_ACCENT, enabled ? "true" : "false");
			commit({ matchSystemAccent: enabled });

			const api = window.electronAPI;
			if (!enabled || !api || !get().supportsAccent) return;
			void api.getAccentScheme().then((data) => {
				if (data.accentScheme) recordSystemAccent(data.accentScheme);
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
