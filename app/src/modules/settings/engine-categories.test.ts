/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The shelves, not the entries on them (#586).
 *
 * The sidebar's engine section is this registry in this order, and an entry
 * whose category is not in it is dropped from search entirely - so the set of
 * ids here is a contract with `seed_default_config`, and the order and the
 * casing are the two things about it a reader cannot check by reading one file.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { ENGINE_SETTINGS_CATEGORIES, getEngineCategory } from "./engine-categories";
import { ENGINE_SETTINGS_EDITED_IN_APP } from "./engine-settings-edited-in-app";
import { APP_SETTINGS_PANELS } from "./main/app-panels";
import { APP_SETTINGS } from "./main/app-settings";

/** Held in the testkit, so CI routes an edit to the seed back to this suite. */
const [DATABASE_CPP] = ENGINE_READING_GUARDS.settingsShelves.paths.map(fromRepoRoot);

describe("the engine category registry", () => {
	it("lists the categories the engine seeds, in visit order", () => {
		// Core first because everything starts there; Scripting last because
		// most users never open it. This used to run Core, Database
		// Performance, Network, Scripting, Observability - the least-visited
		// category second, and the one users arrive with questions about last.
		//
		// Limits joined second-to-last in #703 by the same rule: its entries
		// are reached from a rejection message that names the setting, never
		// by browsing, so it ranks below the shelves people open.
		expect(ENGINE_SETTINGS_CATEGORIES.map((c) => c.id)).toEqual([
			"general_engine",
			"network_performance",
			"services",
			"observability",
			"data_retention",
			"limits",
			"scripting_sandbox",
		]);
	});

	it("labels every category in sentence case, like the app panels above them", () => {
		// "Network & Connectivity" beside "Load testing" is the seam the #518
		// voice pass left: it covered entry labels and not category labels.
		for (const category of ENGINE_SETTINGS_CATEGORIES) {
			const words = category.label.split(/\s+/).slice(1);
			const capitalisedAfterTheFirst = words.filter(
				(word) => /^[A-Z]/.test(word) && word !== "&"
			);
			expect(capitalisedAfterTheFirst).toEqual([]);
		}
	});

	it("says General exactly once across both sidebar sections", () => {
		const labels = [
			...APP_SETTINGS_PANELS.map((p) => p.label),
			...ENGINE_SETTINGS_CATEGORIES.map((c) => c.label),
		];
		expect(labels.filter((label) => label.toLowerCase().includes("general"))).toEqual([
			"General",
		]);
	});

	it("expands its one acronym rather than leaving MCP to be recognised", () => {
		const mcp = APP_SETTINGS_PANELS.find((p) => p.id === "mcp");
		expect(mcp?.label).toBe("AI agents (MCP)");
		// Still findable by eye for someone who arrives knowing the term.
		expect(mcp?.label).toContain("MCP");
	});

	it("gives every category a description, since the header prints one", () => {
		for (const category of ENGINE_SETTINGS_CATEGORIES) {
			expect(category.description.length).toBeGreaterThan(20);
		}
	});

	it("looks a category up by id and answers undefined for a client one", () => {
		expect(getEngineCategory("services")?.label).toBe("Services");
		expect(getEngineCategory("dashboard")).toBeUndefined();
		expect(getEngineCategory(null)).toBeUndefined();
	});
});

/**
 * The other half of the contract, checked across the language boundary.
 *
 * `ConfigRouteTest.EverySeededEntrySitsInADeclaredCategory` pins the same rule
 * engine-side, but against a `std::set` hand-copied from this file - so a
 * category added to the seed and to that set, and forgotten here, passes there
 * and takes the entry off the screen. This side reads the seed itself, which is
 * the only copy neither test can restate wrongly.
 */
describe("the seed and the registry agree on the shelves", () => {
	const seed = readFileSync(DATABASE_CPP, "utf8");

	const registered = new Set<string>(ENGINE_SETTINGS_CATEGORIES.map((c) => c.id));

	/**
	 * One record per seeded entry: its key, and the registered category id
	 * found inside its `ConfigEntry{...}` literal.
	 *
	 * The category is matched *against the registry*, so a typo (or an id this
	 * file does not carry) yields `undefined` and fails below naming the key -
	 * which is the drift the alarm exists for. Every entry ends at `now }`, the
	 * last field of the struct.
	 */
	const seeded = [...seed.matchAll(/ConfigEntry\{\s*"([A-Za-z0-9_]+)"/g)].map((match) => {
		const body = seed.slice(match.index, seed.indexOf("now }", match.index));
		const found = [...body.matchAll(/"([a-z][a-z_]*)"/g)]
			.map((m) => m[1])
			.filter((literal) => registered.has(literal));
		return { key: match[1], category: found[0], matches: found.length };
	});

	it("read a non-empty seed carrying every entry", () => {
		// The failure CLAUDE.md documents: a source scan that reads "" (or the
		// wrong path) satisfies every assertion below for the wrong reason.
		expect(seed.length).toBeGreaterThan(0);
		expect(seeded.length).toBeGreaterThan(40);
	});

	it("puts every seeded entry on a shelf this registry draws", () => {
		// An entry in a category the renderer does not know is not a cosmetic
		// mismatch: SettingsMain filters on it and buildSettingsIndex drops it,
		// so the setting is on no screen and in no search result.
		const orphaned = seeded.filter((entry) => entry.category === undefined).map((e) => e.key);
		expect(orphaned).toEqual([]);

		// Exactly one, so a description that happens to quote another id is not
		// silently taken for the entry's own category.
		const ambiguous = seeded.filter((entry) => entry.matches !== 1).map((e) => e.key);
		expect(ambiguous).toEqual([]);
	});

	it("draws no shelf the seed leaves empty", () => {
		// The other direction: a sidebar row with nothing under it. "Database
		// Performance" was retired for holding three entries; zero is worse.
		const held = new Set(seeded.map((entry) => entry.category));
		expect([...registered].filter((id) => !held.has(id))).toEqual([]);
	});
});

describe("engine entries an app panel row edits", () => {
	it("points every one of them at a row that exists", () => {
		// This map is a redirect. An anchor no panel renders would take the
		// entry out of the engine list and out of the search index, which is a
		// deletion wearing the word "move".
		const rows = new Set(APP_SETTINGS.map((s) => `${s.panel}:${s.anchor}`));
		const panels = new Set(APP_SETTINGS_PANELS.map((p) => p.id));

		const declared = Object.entries(ENGINE_SETTINGS_EDITED_IN_APP);
		expect(declared.length).toBeGreaterThan(0);

		const danglingPanel = declared
			.filter(([, editor]) => !panels.has(editor.panel))
			.map(([key]) => key);
		const danglingAnchor = declared
			.filter(([, editor]) => !rows.has(`${editor.panel}:${editor.anchor}`))
			.map(([key]) => key);

		expect(danglingPanel).toEqual([]);
		expect(danglingAnchor).toEqual([]);
	});
});
