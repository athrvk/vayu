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
 *  but NOT workspace/session state (open tabs, layout, active collection).
 *  The live chart window is deliberately absent: it is engine config
 *  (`liveReplayWindowMs`), not a renderer preference, so it resets with the
 *  engine's settings rather than with the app's. */
export const SETTINGS_STORAGE_KEYS: readonly string[] = [
	STORAGE_KEYS.THEME_SOURCE,
	STORAGE_KEYS.COLOR_SCHEME,
	STORAGE_KEYS.UI_FONT,
	STORAGE_KEYS.UI_FONT_CUSTOM,
	STORAGE_KEYS.UI_SCALE,
	STORAGE_KEYS.UI_RADIUS,
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

/** A stored nested preference object, completed against the current defaults. */
function completeNested<T extends object>(defaults: T, stored: unknown): T {
	return stored && typeof stored === "object" && !Array.isArray(stored)
		? { ...defaults, ...(stored as Partial<T>) }
		: { ...defaults };
}

/**
 * Zustand's shallow merge, plus one level of defaults under each nested object.
 *
 * The default merge is a top-level spread, so a payload written before a key
 * was added to one of these objects replaces the whole object and ships
 * `undefined` for the new key: `notifications.maxVisible` feeds
 * `slice(-maxVisible)` in `toast-store`, and `slice(-undefined)` is
 * `slice(NaN)` - the toast cap silently stops capping. `loadTestCeilings`
 * already carried that defense written out by hand.
 *
 * Every object-valued preference needs a line here, and the store's own test
 * enumerates them rather than trusting this list - a fifth nested pref that is
 * not completed fails there.
 */
function mergeWithNestedDefaults(
	persisted: unknown,
	current: ClientSettingsState
): ClientSettingsState {
	if (!persisted || typeof persisted !== "object") return current;
	const stored = persisted as Partial<ClientSettingsState>;
	return {
		...current,
		...stored,
		editor: completeNested(DEFAULT_EDITOR_PREFS, stored.editor),
		autoSave: completeNested(DEFAULT_AUTO_SAVE_PREFS, stored.autoSave),
		notifications: completeNested(DEFAULT_NOTIFICATION_PREFS, stored.notifications),
		loadTestCeilings: completeNested(DEFAULT_LOAD_TEST_CEILINGS, stored.loadTestCeilings),
	};
}

/**
 * Version translation for the stored preferences.
 *
 * There is one shape so far, so this only has to hand the payload back -
 * `mergeWithNestedDefaults` fills in anything missing. It exists for the next
 * bump: zustand *discards* a payload whose stamped version does not match when
 * no `migrate` is given (it logs and hands the store its defaults), so a bump
 * without one resets every preference. Add a branch here instead.
 *
 * The payloads already in users' localStorage carry no version at all, and
 * zustand only compares when one was stamped - which is why declaring
 * `version: 1` here does not reset anyone.
 */
function migrateClientSettings(persisted: unknown) {
	return (persisted ?? {}) as Partial<ClientSettingsState>;
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
			version: 1,
			migrate: migrateClientSettings,
			merge: mergeWithNestedDefaults,
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
					// it. Filling in a key added after the payload was written
					// is `mergeWithNestedDefaults`'s job now, for every nested
					// object rather than this one.
					state.loadTestCeilings = clampCeilings(state.loadTestCeilings);
				}
			},
		}
	)
);
