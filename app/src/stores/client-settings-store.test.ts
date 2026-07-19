/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useClientSettingsStore, SETTINGS_STORAGE_KEYS } from "./client-settings-store";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import {
	DEFAULT_EDITOR_PREFS,
	DEFAULT_SLO_THRESHOLD_MS,
	SLO_THRESHOLD_MAX_MS,
} from "@/constants/client-settings";
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
		expect(SETTINGS_STORAGE_KEYS).toContain(STORAGE_KEYS.LIVE_CHART_WINDOW);
		// Session/workspace state must NOT be wiped by a settings reset.
		expect(SETTINGS_STORAGE_KEYS).not.toContain(STORAGE_KEYS.TABS_STORE);
		expect(SETTINGS_STORAGE_KEYS).not.toContain(STORAGE_KEYS.SESSION_STORE);
		expect(SETTINGS_STORAGE_KEYS).not.toContain(STORAGE_KEYS.LAYOUT_STORE);
	});
});
