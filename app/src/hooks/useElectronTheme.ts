/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useElectronTheme Hook
 *
 * React face of {@link useThemeStore} - light/dark mode and the accent colour
 * scheme, synced with the OS/Electron theme settings. The store owns the
 * values, the persistence, the OS subscriptions and the one write to `<html>`;
 * this hook only holds the store attached while a component is mounted.
 *
 * Mounted by the app shell, the Appearance panel and the command palette. They
 * all read the same store, so none of them can re-apply a stale copy (#1855).
 * Falls back gracefully when not running in Electron.
 */

import { useEffect } from "react";
import { useThemeStore } from "@/stores";
import type { ThemeSource } from "@/types/ui";
import type { ColorScheme } from "@/constants/color-schemes";

// Re-exported so existing `@/hooks/useElectronTheme` type imports keep working.
export type { ThemeSource, ColorScheme };

export function useElectronTheme() {
	const themeSource = useThemeStore((s) => s.themeSource);
	const colorScheme = useThemeStore((s) => s.colorScheme);
	const isDark = useThemeStore((s) => s.isDark);
	const isLoading = useThemeStore((s) => s.isLoading);
	const matchSystemAccent = useThemeStore((s) => s.matchSystemAccent);
	const supportsAccent = useThemeStore((s) => s.supportsAccent);
	const setTheme = useThemeStore((s) => s.setTheme);
	const setColorScheme = useThemeStore((s) => s.setColorScheme);
	const setMatchAccent = useThemeStore((s) => s.setMatchAccent);

	// Reference-counted in the store: the first mounted instance reads the
	// persisted and OS state and subscribes, the last to unmount lets go.
	useEffect(() => useThemeStore.getState().attach(), []);

	return {
		themeSource,
		setTheme,
		colorScheme,
		setColorScheme,
		isDark,
		isLoading,
		matchSystemAccent,
		setMatchAccent,
		supportsAccent,
	};
}
