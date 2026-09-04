/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useClientSettingsStore, SETTINGS_STORAGE_KEYS } from "./client-settings-store";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import {
	DEFAULT_EDITOR_PREFS,
	DEFAULT_SLO_THRESHOLD_MS,
	SLO_THRESHOLD_MAX_MS,
} from "@/constants/client-settings";
import { DEFAULT_NOTIFICATION_PREFS } from "@/constants/toast";
import { DEFAULT_MONO_FONT } from "@/constants/appearance";

describe("client-settings store", () => {
	beforeEach(() => {
		useClientSettingsStore.setState({
			editor: { ...DEFAULT_EDITOR_PREFS },
			monoFont: DEFAULT_MONO_FONT,
			chartBucketSeconds: 0.5,
			sloThresholdMs: DEFAULT_SLO_THRESHOLD_MS,
			liveRefreshMs: 500,
			autoSave: { enabled: true, delayMs: 3000 },
			reducedMotion: false,
		});
	});

	it("exposes sane defaults", () => {
		const s = useClientSettingsStore.getState();
		expect(s.editor.fontSize).toBe(DEFAULT_EDITOR_PREFS.fontSize);
		expect(s.sloThresholdMs).toBe(DEFAULT_SLO_THRESHOLD_MS);
		expect(s.autoSave.enabled).toBe(true);
	});

	it("merges partial editor updates without dropping other keys", () => {
		useClientSettingsStore.getState().setEditor({ minimap: true });
		const e = useClientSettingsStore.getState().editor;
		expect(e.minimap).toBe(true);
		expect(e.fontSize).toBe(DEFAULT_EDITOR_PREFS.fontSize); // untouched
		expect(e.wordWrap).toBe(DEFAULT_EDITOR_PREFS.wordWrap);
	});

	it("clamps the SLO threshold to the allowed range", () => {
		const { setSloThresholdMs } = useClientSettingsStore.getState();
		setSloThresholdMs(0); // below min → clamped up to 1
		expect(useClientSettingsStore.getState().sloThresholdMs).toBe(1);
		setSloThresholdMs(999_999); // above max → clamped down
		expect(useClientSettingsStore.getState().sloThresholdMs).toBe(SLO_THRESHOLD_MAX_MS);
		setSloThresholdMs(350);
		expect(useClientSettingsStore.getState().sloThresholdMs).toBe(350);
	});

	it("merges partial auto-save updates", () => {
		useClientSettingsStore.getState().setAutoSave({ enabled: false });
		const a = useClientSettingsStore.getState().autoSave;
		expect(a.enabled).toBe(false);
		expect(a.delayMs).toBe(3000); // untouched
	});

	it("toggles reduced motion and flags the document", () => {
		useClientSettingsStore.getState().setReducedMotion(true);
		expect(useClientSettingsStore.getState().reducedMotion).toBe(true);
		expect(document.documentElement.getAttribute("data-reduced-motion")).toBe("true");
		useClientSettingsStore.getState().setReducedMotion(false);
		expect(document.documentElement.hasAttribute("data-reduced-motion")).toBe(false);
	});

	it("reset key list covers every renderer preference but not workspace state", () => {
		expect(SETTINGS_STORAGE_KEYS).toContain(STORAGE_KEYS.CLIENT_SETTINGS);
		expect(SETTINGS_STORAGE_KEYS).toContain(STORAGE_KEYS.THEME_SOURCE);
		expect(SETTINGS_STORAGE_KEYS).toContain(STORAGE_KEYS.UI_RADIUS);
		// The live chart window is engine config (`liveReplayWindowMs`), not a
		// renderer preference, so it has no localStorage key to reset here - the
		// engine owns it because it also sizes the SSE replay ring from it.
		expect(SETTINGS_STORAGE_KEYS).not.toContain("vayu-live-chart-window");
		// Session/workspace state must NOT be wiped by a settings reset.
		expect(SETTINGS_STORAGE_KEYS).not.toContain(STORAGE_KEYS.TABS_STORE);
		expect(SETTINGS_STORAGE_KEYS).not.toContain(STORAGE_KEYS.SESSION_STORE);
		expect(SETTINGS_STORAGE_KEYS).not.toContain(STORAGE_KEYS.LAYOUT_STORE);
	});
});

/**
 * What survives a reload.
 *
 * Two failure modes, both of which hand a component `undefined` where it reads
 * a number. Zustand discards a persisted payload whose stamped version does not
 * match unless a `migrate` is supplied, and its default merge is a top-level spread -
 * so a stored nested object replaces its defaults wholesale, and the next key
 * added to `NotificationPrefs` or `EditorPrefs` would arrive undefined for
 * every existing user. `notifications.maxVisible` is the live example:
 * `toast-store` caps the queue with `slice(-maxVisible)`, and `slice(-undefined)`
 * is `slice(NaN)` - no cap at all, silently.
 */
describe("client-settings rehydration", () => {
	const seed = (payload: unknown) =>
		localStorage.setItem(STORAGE_KEYS.CLIENT_SETTINGS, JSON.stringify(payload));

	// Explicit, not inherited: the suite above leaves the store wherever its last
	// case put it, and a rehydration test that starts from the value it is about
	// to assert proves nothing.
	beforeEach(() => {
		useClientSettingsStore.setState({
			sloThresholdMs: DEFAULT_SLO_THRESHOLD_MS,
			notifications: { ...DEFAULT_NOTIFICATION_PREFS },
			systemNotifications: false,
		});
	});

	afterEach(() => localStorage.removeItem(STORAGE_KEYS.CLIENT_SETTINGS));

	it("keeps preferences written before the store carried a version", async () => {
		// zustand only compares versions when the payload stamped one (`typeof
		// version === "number"`), so declaring `version: 1` does not strand the
		// unversioned payloads already in everyone's localStorage. Pinned because
		// the bump would be a bad trade if it did.
		expect(DEFAULT_SLO_THRESHOLD_MS).not.toBe(350); // the assertion below must bite
		seed({ state: { sloThresholdMs: 350 } });

		await useClientSettingsStore.persist.rehydrate();

		expect(useClientSettingsStore.getState().sloThresholdMs).toBe(350);
	});

	it("translates a stamped older version instead of discarding it", async () => {
		// What `migrate` is actually for. A stamped version that does not match
		// is discarded outright when no migrate is supplied - zustand logs and
		// hands the store its defaults - so the next bump would silently reset
		// every preference. This is that bump, rehearsed one version early.
		seed({ version: 0, state: { sloThresholdMs: 350 } });

		await useClientSettingsStore.persist.rehydrate();

		expect(useClientSettingsStore.getState().sloThresholdMs).toBe(350);
	});

	it("carries the system-notification opt-in across a reload", async () => {
		// Both halves, because they fail differently. A field left out of
		// `partialize` reaches localStorage never - it writes, it reads, and it is
		// gone on the next launch, "written but never read" one launch later - and
		// a field the merge drops comes back as its default.
		useClientSettingsStore.setState({ systemNotifications: true });
		const written: unknown = JSON.parse(
			localStorage.getItem(STORAGE_KEYS.CLIENT_SETTINGS) ?? "{}"
		);
		expect(
			(written as { state: { systemNotifications?: boolean } }).state.systemNotifications
		).toBe(true);

		// A fresh launch, reading back exactly what the line above wrote. Seeded
		// again because the reset below is itself a write, and persist stores it.
		useClientSettingsStore.setState({ systemNotifications: false });
		seed(written);
		await useClientSettingsStore.persist.rehydrate();

		expect(useClientSettingsStore.getState().systemNotifications).toBe(true);
	});

	it("completes a nested object stored before a key was added to it", async () => {
		seed({ version: 1, state: { notifications: { position: "top-right" } } });

		await useClientSettingsStore.persist.rehydrate();

		const n = useClientSettingsStore.getState().notifications;
		expect(n.position).toBe("top-right"); // the stored key still wins
		expect(n.maxVisible).toBe(DEFAULT_NOTIFICATION_PREFS.maxVisible);
		expect(n.minSeverity).toBe(DEFAULT_NOTIFICATION_PREFS.minSeverity);
	});

	it("completes every object-valued preference, not only the ones named today", async () => {
		// Enumerated rather than listed: a fifth nested preference that nobody
		// wired into the merge fails here instead of shipping `undefined` keys.
		const nested = (): Record<string, Record<string, unknown>> =>
			Object.fromEntries(
				Object.entries(useClientSettingsStore.getState()).filter(
					([, v]) => v !== null && typeof v === "object"
				)
			) as Record<string, Record<string, unknown>>;

		const expected = nested();
		const keys = Object.keys(expected);
		expect(keys.length).toBeGreaterThan(3); // guards the enumeration itself

		for (const key of keys) {
			seed({ version: 1, state: { [key]: {} } });
			await useClientSettingsStore.persist.rehydrate();

			expect({ [key]: Object.keys(nested()[key]).sort() }).toEqual({
				[key]: Object.keys(expected[key]).sort(),
			});
		}
	});
});
