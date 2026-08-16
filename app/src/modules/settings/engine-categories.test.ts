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

import { describe, it, expect } from "vitest";
import { ENGINE_SETTINGS_CATEGORIES, getEngineCategory } from "./engine-categories";
import { ENGINE_SETTINGS_EDITED_IN_APP } from "./engine-settings-edited-in-app";
import { APP_SETTINGS_PANELS } from "./main/app-panels";
import { APP_SETTINGS } from "./main/app-settings";

describe("the engine category registry", () => {
	it("lists the categories the engine seeds, in visit order", () => {
		// Core first because everything starts there; Scripting last because
		// most users never open it. This used to run Core, Database
		// Performance, Network, Scripting, Observability - the least-visited
		// category second, and the one users arrive with questions about last.
		expect(ENGINE_SETTINGS_CATEGORIES.map((c) => c.id)).toEqual([
			"general_engine",
			"network_performance",
			"services",
			"observability",
			"data_retention",
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
