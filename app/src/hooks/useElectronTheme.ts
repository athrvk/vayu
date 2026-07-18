/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useElectronTheme Hook
 *
 * Syncs the app theme with the OS/Electron theme settings.
 * Supports both light/dark mode and color schemes.
 * Falls back gracefully when not running in Electron.
 */

import { useEffect, useCallback, useState } from "react";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import type { ThemeSource } from "@/types/ui";
import { DEFAULT_COLOR_SCHEME, isColorScheme, type ColorScheme } from "@/constants/color-schemes";

// Re-exported so existing `@/hooks/useElectronTheme` type imports keep working.
export type { ThemeSource, ColorScheme };

interface UseElectronThemeOptions {
	/** Called when theme changes */
	onThemeChange?: (isDark: boolean) => void;
}

export function useElectronTheme(options: UseElectronThemeOptions = {}) {
	const { onThemeChange } = options;
	const [themeSource, setThemeSource] = useState<ThemeSource>("system");
	const [colorScheme, setColorScheme] = useState<ColorScheme>(DEFAULT_COLOR_SCHEME);
	const [isDark, setIsDark] = useState(false);
	const [isLoading, setIsLoading] = useState(true);

	// Apply theme to document. `scheme` is required (not defaulted from state) so
	// this callback stays stable across accent changes — otherwise the init
	// effect below, keyed on it, would re-run (and re-hit Electron) every time
	// the accent changes.
	const applyTheme = useCallback(
		(dark: boolean, scheme: ColorScheme) => {
			// Apply dark mode class
			if (dark) {
				document.documentElement.classList.add("dark");
			} else {
				document.documentElement.classList.remove("dark");
			}

			// Apply color scheme data attribute
			document.documentElement.setAttribute("data-color-scheme", scheme);

			setIsDark(dark);
			onThemeChange?.(dark);
		},
		[onThemeChange]
	);

	// Initialize theme
	useEffect(() => {
		const initTheme = async () => {
			let source: ThemeSource = "system";

			// Load from localStorage
			const savedSource = localStorage.getItem(
				STORAGE_KEYS.THEME_SOURCE
			) as ThemeSource | null;
			const rawScheme = localStorage.getItem(STORAGE_KEYS.COLOR_SCHEME);
			const scheme: ColorScheme = isColorScheme(rawScheme) ? rawScheme : DEFAULT_COLOR_SCHEME;

			if (window.electronAPI) {
				// Get theme from Electron
				const theme = await window.electronAPI.getTheme();
				source = theme.themeSource as ThemeSource;
				applyTheme(theme.shouldUseDarkColors, scheme);
			} else {
				// Fallback: check localStorage or system preference
				if (savedSource) {
					source = savedSource;
					if (source === "system") {
						const prefersDark = window.matchMedia(
							"(prefers-color-scheme: dark)"
						).matches;
						applyTheme(prefersDark, scheme);
					} else {
						applyTheme(source === "dark", scheme);
					}
				} else {
					const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
					applyTheme(prefersDark, scheme);
				}
			}

			setThemeSource(source);
			setColorScheme(scheme);
			setIsLoading(false);
		};

		initTheme();
	}, [applyTheme]);

	// Listen for theme changes
	useEffect(() => {
		if (window.electronAPI) {
			// Listen for Electron theme changes
			const cleanup = window.electronAPI.onThemeChanged((theme) => {
				setThemeSource(theme.themeSource as ThemeSource);
				applyTheme(theme.shouldUseDarkColors, colorScheme);
			});
			return cleanup;
		} else {
			// Fallback: listen for system preference changes (only if using system theme)
			if (themeSource === "system") {
				const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
				const handler = (e: MediaQueryListEvent) => applyTheme(e.matches, colorScheme);
				mediaQuery.addEventListener("change", handler);
				return () => mediaQuery.removeEventListener("change", handler);
			}
		}
	}, [applyTheme, themeSource, colorScheme]);

	// Function to change theme source (light/dark)
	const setTheme = useCallback(
		async (source: ThemeSource) => {
			setThemeSource(source);

			if (window.electronAPI) {
				const theme = await window.electronAPI.setTheme(source);
				applyTheme(theme.shouldUseDarkColors, colorScheme);
			} else {
				// Fallback: manually set theme
				if (source === "system") {
					const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
					applyTheme(prefersDark, colorScheme);
				} else {
					applyTheme(source === "dark", colorScheme);
				}
			}
			// Persist preference
			localStorage.setItem(STORAGE_KEYS.THEME_SOURCE, source);
		},
		[applyTheme, colorScheme]
	);

	// Function to change color scheme
	const changeColorScheme = useCallback(
		(scheme: ColorScheme) => {
			setColorScheme(scheme);
			const isDark = document.documentElement.classList.contains("dark");
			applyTheme(isDark, scheme);
			localStorage.setItem(STORAGE_KEYS.COLOR_SCHEME, scheme);
		},
		[applyTheme]
	);

	return {
		themeSource,
		setTheme,
		colorScheme,
		setColorScheme: changeColorScheme,
		isDark,
		isLoading,
	};
}
