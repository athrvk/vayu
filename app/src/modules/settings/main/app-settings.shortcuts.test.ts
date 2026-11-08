/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Settings search finds the shortcuts panel by the action a chord performs
 * (#3325). "zoom" used to answer with Scale alone and "full screen" with
 * nothing, because the panel listed neither the menu's chords nor the tree's.
 */

import { describe, it, expect } from "vitest";
import { buildSettingsIndex, searchSettings } from "@/lib/settings-index";
import { SHORTCUT_GROUPS } from "@/constants/shortcuts";
import { appSetting } from "./app-settings";

const index = buildSettingsIndex({
	panels: [{ id: "shortcuts", label: "Keyboard shortcuts", description: "Reference" }],
	appSettings: [appSetting("keyboard-shortcuts")],
	engineEntries: [],
	engineCategories: [],
});

describe("searching for a shortcut by what it does", () => {
	it.each(["zoom", "full screen", "rename", "delete", "quit", "close window"])(
		"finds the shortcuts panel for %s",
		(query) => {
			const hit = searchSettings(index, query).find(
				(entry) => entry.id === "keyboard-shortcuts"
			);
			expect(hit?.category).toBe("shortcuts");
		}
	);

	it("finds the panel by the label of every chord it lists", () => {
		const chords = SHORTCUT_GROUPS.flatMap((group) => [...group.chords]);
		expect(chords.length).toBeGreaterThan(30);
		for (const chord of chords) {
			const ids = searchSettings(index, chord.label as string).map((entry) => entry.id);
			expect(ids, chord.label).toContain("keyboard-shortcuts");
		}
	});
});
