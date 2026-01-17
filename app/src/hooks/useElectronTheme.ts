/**
 * useElectronTheme Hook
 *
 * Syncs the app theme with the OS/Electron theme settings.
 * Supports both light/dark mode and color schemes.
 * Falls back gracefully when not running in Electron.
 */

import { useEffect, useCallback, useState } from "react";

export type ThemeSource = "system" | "light" | "dark";
export type ColorScheme = "sky" | "ocean" | "forest" | "sunset" | "aurora" | "coral";

interface UseElectronThemeOptions {
	/** Called when theme changes */
	onThemeChange?: (isDark: boolean) => void;
}

export function useElectronTheme(options: UseElectronThemeOptions = {}) {
	const { onThemeChange } = options;
	const [themeSource, setThemeSource] = useState<ThemeSource>("system");
	const [colorScheme, setColorScheme] = useState<ColorScheme>("sunset");
	const [isLoading, setIsLoading] = useState(true);

	// Apply theme to document
	const applyTheme = useCallback(
		(isDark: boolean, scheme: ColorScheme = colorScheme) => {
			// Apply dark mode class
			if (isDark) {
				document.documentElement.classList.add("dark");
			} else {
				document.documentElement.classList.remove("dark");
			}

			// Apply color scheme data attribute
			document.documentElement.setAttribute("data-color-scheme", scheme);

			onThemeChange?.(isDark);
		},
		[colorScheme, onThemeChange]
	);

	// Initialize theme
	useEffect(() => {
		const initTheme = async () => {
			let source: ThemeSource = "system";
			let scheme: ColorScheme = "sunset";

			// Load from localStorage
			const savedSource = localStorage.getItem("vayu-theme-source") as ThemeSource | null;
			const savedScheme = localStorage.getItem("vayu-color-scheme") as ColorScheme | null;

			if (window.electronAPI) {
				// Get theme from Electron
				const theme = await window.electronAPI.getTheme();
				source = theme.themeSource as ThemeSource;
				applyTheme(theme.shouldUseDarkColors, savedScheme || scheme);
			} else {
				// Fallback: check localStorage or system preference
				if (savedSource) {
					source = savedSource;
					if (source === "system") {
						const prefersDark = window.matchMedia(
							"(prefers-color-scheme: dark)"
						).matches;
						applyTheme(prefersDark, savedScheme || scheme);
					} else {
						applyTheme(source === "dark", savedScheme || scheme);
					}
				} else {
					const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
					applyTheme(prefersDark, savedScheme || scheme);
				}
			}

			if (savedScheme) {
				scheme = savedScheme;
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
			localStorage.setItem("vayu-theme-source", source);
		},
		[applyTheme, colorScheme]
	);

	// Function to change color scheme
	const changeColorScheme = useCallback(
		(scheme: ColorScheme) => {
			setColorScheme(scheme);
			const isDark = document.documentElement.classList.contains("dark");
			applyTheme(isDark, scheme);
			localStorage.setItem("vayu-color-scheme", scheme);
		},
		[applyTheme]
	);

	return { themeSource, setTheme, colorScheme, setColorScheme: changeColorScheme, isLoading };
}
