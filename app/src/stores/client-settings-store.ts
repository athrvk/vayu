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

import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from "@/constants/toast";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import {
	DEFAULT_MONO_FONT,
	monoFontStack,
	customMonoStack,
	type MonoFontChoice,
} from "@/constants/appearance";
import {
	DEFAULT_EDITOR_PREFS,
	DEFAULT_AUTO_SAVE_PREFS,
	DEFAULT_CHART_BUCKET_SECONDS,
	DEFAULT_SLO_THRESHOLD_MS,
	DEFAULT_LIVE_REFRESH_MS,
	clampSloThresholdMs,
	type EditorPrefs,
	type AutoSavePrefs,
	nearestAutoSaveDelay,
} from "@/constants/client-settings";
import {
	DEFAULT_LOAD_TEST_CEILINGS,
	clampCeilings,
	type LoadTestCeilings,
} from "@/constants/load-test";

/** localStorage keys reset by "Reset app settings" - all renderer preferences,
 *  but NOT workspace/session state (open tabs, layout, active collection). */
export const SETTINGS_STORAGE_KEYS: readonly string[] = [
	STORAGE_KEYS.THEME_SOURCE,
	STORAGE_KEYS.COLOR_SCHEME,
	STORAGE_KEYS.UI_FONT,
	STORAGE_KEYS.UI_FONT_CUSTOM,
	STORAGE_KEYS.UI_SCALE,
	STORAGE_KEYS.UI_RADIUS,
	STORAGE_KEYS.LIVE_CHART_WINDOW,
	STORAGE_KEYS.CLIENT_SETTINGS,
];

interface ClientSettingsState {
	editor: EditorPrefs;
	/** Selected code font - a preset or "custom". */
	monoFont: MonoFontChoice;
	/** User-typed family, used when monoFont === "custom". */
	monoFontCustom: string;
	chartBucketSeconds: number;
	sloThresholdMs: number;
	liveRefreshMs: number;
	autoSave: AutoSavePrefs;
	reducedMotion: boolean;
	/** Toast position, duration scale, stack cap and severity floor. */
	notifications: NotificationPrefs;
	/** Upper bounds the load-test dialog offers. Read via `resolveLoadTestLimits`. */
	loadTestCeilings: LoadTestCeilings;

	setEditor: (patch: Partial<EditorPrefs>) => void;
	setMonoFont: (font: MonoFontChoice) => void;
	setMonoFontCustom: (family: string) => void;
	setChartBucketSeconds: (seconds: number) => void;
	setSloThresholdMs: (ms: number) => void;
	setLiveRefreshMs: (ms: number) => void;
	setAutoSave: (patch: Partial<AutoSavePrefs>) => void;
	setNotifications: (patch: Partial<NotificationPrefs>) => void;
	setReducedMotion: (on: boolean) => void;
	/** Patch one or more ceilings; each is clamped to what the engine accepts. */
	setLoadTestCeilings: (patch: Partial<LoadTestCeilings>) => void;
	/** Clear every renderer preference and reload so defaults re-apply cleanly. */
	resetAll: () => void;
}

/** Resolve the active code-font CSS stack (preset or custom family). */
function resolveMonoStack(font: MonoFontChoice, custom: string): string {
	return font === "custom" ? customMonoStack(custom) : monoFontStack(font);
}

/** Selector: the active code-font stack - used by the Monaco wrapper. */
export function selectMonoStack(s: { monoFont: MonoFontChoice; monoFontCustom: string }): string {
	return resolveMonoStack(s.monoFont, s.monoFontCustom);
}

/** Push the resolved stack onto `--font-mono` so `font-mono` utilities pick it
 *  up immediately (the Monaco editor reads the same stack via CodeEditor). */
function applyMonoStack(stack: string): void {
	if (typeof document === "undefined") return;
	document.documentElement.style.setProperty("--font-mono", stack);
}

/** Flag the document so the global CSS can collapse transitions/animations. */
function applyReducedMotion(on: boolean): void {
	if (typeof document === "undefined") return;
	if (on) document.documentElement.setAttribute("data-reduced-motion", "true");
	else document.documentElement.removeAttribute("data-reduced-motion");
}

export const useClientSettingsStore = create<ClientSettingsState>()(
	persist(
		(set, get) => ({
			editor: { ...DEFAULT_EDITOR_PREFS },
			monoFont: DEFAULT_MONO_FONT,
			monoFontCustom: "",
			chartBucketSeconds: DEFAULT_CHART_BUCKET_SECONDS,
			sloThresholdMs: DEFAULT_SLO_THRESHOLD_MS,
			liveRefreshMs: DEFAULT_LIVE_REFRESH_MS,
			autoSave: { ...DEFAULT_AUTO_SAVE_PREFS },
			reducedMotion: false,
			notifications: { ...DEFAULT_NOTIFICATION_PREFS },
			loadTestCeilings: { ...DEFAULT_LOAD_TEST_CEILINGS },

			setEditor: (patch) => set((s) => ({ editor: { ...s.editor, ...patch } })),
			setMonoFont: (font) => {
				applyMonoStack(resolveMonoStack(font, get().monoFontCustom));
				set({ monoFont: font });
			},
			setMonoFontCustom: (family) => {
				set({ monoFontCustom: family });
				if (get().monoFont === "custom") applyMonoStack(customMonoStack(family));
			},
			setChartBucketSeconds: (seconds) => set({ chartBucketSeconds: seconds }),
			setSloThresholdMs: (ms) => set({ sloThresholdMs: clampSloThresholdMs(ms) }),
			setLiveRefreshMs: (ms) => set({ liveRefreshMs: ms }),
			setAutoSave: (patch) => set((s) => ({ autoSave: { ...s.autoSave, ...patch } })),
			setNotifications: (patch) =>
				set((s) => ({ notifications: { ...s.notifications, ...patch } })),
			setReducedMotion: (on) => {
				applyReducedMotion(on);
				set({ reducedMotion: on });
			},
			// Clamped on the way in, not only on the way out: the dialog reads
			// this to build its own ranges, so an out-of-range ceiling stored
			// here would present the user a value the engine rejects.
			setLoadTestCeilings: (patch) =>
				set((s) => ({
					loadTestCeilings: clampCeilings({ ...s.loadTestCeilings, ...patch }),
				})),

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
				monoFontCustom: s.monoFontCustom,
				chartBucketSeconds: s.chartBucketSeconds,
				sloThresholdMs: s.sloThresholdMs,
				liveRefreshMs: s.liveRefreshMs,
				autoSave: s.autoSave,
				reducedMotion: s.reducedMotion,
				notifications: s.notifications,
				loadTestCeilings: s.loadTestCeilings,
			}),
			onRehydrateStorage: () => (state) => {
				// Re-assert persisted DOM-affecting prefs after rehydrate.
				if (state) {
					applyMonoStack(resolveMonoStack(state.monoFont, state.monoFontCustom));
					applyReducedMotion(state.reducedMotion);

					// The auto-save options changed from 1s/3s/5s to 5s/30s/1m, so a
					// stored 1s or 3s is no longer offered. Snap it to the nearest
					// one that is, otherwise the picker shows nothing selected while
					// auto-save keeps running on the old interval.
					const snapped = nearestAutoSaveDelay(state.autoSave.delayMs);
					if (snapped !== state.autoSave.delayMs) {
						state.autoSave = { ...state.autoSave, delayMs: snapped };
					}

					// Re-clamp on the way out of storage. The bounds are the
					// engine's crash guards, and a build that tightens one
					// would otherwise keep offering the stored ceiling above
					// it. The spread also fills in a key added after the
					// stored payload was written.
					state.loadTestCeilings = clampCeilings({
						...DEFAULT_LOAD_TEST_CEILINGS,
						...state.loadTestCeilings,
					});
				}
			},
		}
	)
);
