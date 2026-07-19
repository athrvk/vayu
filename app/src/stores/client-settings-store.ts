/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Client settings store
 *
 * Central home for renderer-only preferences that aren't part of the
 * pre-paint appearance set (theme/color/UI-font/scale/radius live in their own
 * localStorage keys so index.html can apply them before React mounts). Holds
 * editor behavior, the monospace/code font, chart granularity, the capacity SLO
 * threshold, the live refresh rate, and auto-save. Persisted to localStorage;
 * non-React consumers (services, the dashboard store) read via `getState()`.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import { DEFAULT_MONO_FONT, monoFontStack, type MonoFont } from "@/constants/appearance";
import {
	DEFAULT_EDITOR_PREFS,
	DEFAULT_AUTO_SAVE_PREFS,
	DEFAULT_CHART_BUCKET_SECONDS,
	DEFAULT_SLO_THRESHOLD_MS,
	DEFAULT_LIVE_REFRESH_MS,
	clampSloThresholdMs,
	type EditorPrefs,
	type AutoSavePrefs,
} from "@/constants/client-settings";

/** localStorage keys reset by "Reset app settings" — all renderer preferences,
 *  but NOT workspace/session state (open tabs, layout, active collection). */
export const SETTINGS_STORAGE_KEYS: readonly string[] = [
	STORAGE_KEYS.THEME_SOURCE,
	STORAGE_KEYS.COLOR_SCHEME,
	STORAGE_KEYS.UI_FONT,
	STORAGE_KEYS.UI_SCALE,
	STORAGE_KEYS.UI_RADIUS,
	STORAGE_KEYS.LIVE_CHART_WINDOW,
	STORAGE_KEYS.CLIENT_SETTINGS,
];

interface ClientSettingsState {
	editor: EditorPrefs;
	monoFont: MonoFont;
	chartBucketSeconds: number;
	sloThresholdMs: number;
	liveRefreshMs: number;
	autoSave: AutoSavePrefs;

	setEditor: (patch: Partial<EditorPrefs>) => void;
	setMonoFont: (font: MonoFont) => void;
	setChartBucketSeconds: (seconds: number) => void;
	setSloThresholdMs: (ms: number) => void;
	setLiveRefreshMs: (ms: number) => void;
	setAutoSave: (patch: Partial<AutoSavePrefs>) => void;
	/** Clear every renderer preference and reload so defaults re-apply cleanly. */
	resetAll: () => void;
}

/** Push the monospace font onto `--font-mono` so `font-mono` utilities pick it
 *  up immediately (the Monaco editor reads the same stack via CodeEditor). */
function applyMonoFont(font: MonoFont): void {
	if (typeof document === "undefined") return;
	document.documentElement.style.setProperty("--font-mono", monoFontStack(font));
}

export const useClientSettingsStore = create<ClientSettingsState>()(
	persist(
		(set) => ({
			editor: { ...DEFAULT_EDITOR_PREFS },
			monoFont: DEFAULT_MONO_FONT,
			chartBucketSeconds: DEFAULT_CHART_BUCKET_SECONDS,
			sloThresholdMs: DEFAULT_SLO_THRESHOLD_MS,
			liveRefreshMs: DEFAULT_LIVE_REFRESH_MS,
			autoSave: { ...DEFAULT_AUTO_SAVE_PREFS },

			setEditor: (patch) => set((s) => ({ editor: { ...s.editor, ...patch } })),
			setMonoFont: (font) => {
				applyMonoFont(font);
				set({ monoFont: font });
			},
			setChartBucketSeconds: (seconds) => set({ chartBucketSeconds: seconds }),
			setSloThresholdMs: (ms) => set({ sloThresholdMs: clampSloThresholdMs(ms) }),
			setLiveRefreshMs: (ms) => set({ liveRefreshMs: ms }),
			setAutoSave: (patch) => set((s) => ({ autoSave: { ...s.autoSave, ...patch } })),

			resetAll: () => {
				for (const key of SETTINGS_STORAGE_KEYS) localStorage.removeItem(key);
				// Reload so the pre-paint script and every store re-seed from defaults.
				window.location.reload();
			},
		}),
		{
			name: STORAGE_KEYS.CLIENT_SETTINGS,
			storage: createJSONStorage(() => localStorage),
			partialize: (s) => ({
				editor: s.editor,
				monoFont: s.monoFont,
				chartBucketSeconds: s.chartBucketSeconds,
				sloThresholdMs: s.sloThresholdMs,
				liveRefreshMs: s.liveRefreshMs,
				autoSave: s.autoSave,
			}),
			onRehydrateStorage: () => (state) => {
				// Re-assert the persisted mono font onto the CSS var after rehydrate.
				if (state) applyMonoFont(state.monoFont);
			},
		}
	)
);
