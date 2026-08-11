/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every `TabType` must be answered by all three switches that dispatch on one.
 *
 * A missing branch is not a crash, which is what makes this worth a guard:
 * `renderTabContent` falls through to `null` (a blank tab), `iconForTab` to no
 * glyph, and - the one that has already cost work - `isTabDirty` to `false`,
 * which reads as "clean" and makes the tab eligible for LRU eviction with its
 * edits in it. That is exactly how a dirty Settings tab became evictable.
 *
 * `TabType` is a type, so there is no runtime list to walk: the union is read
 * out of the store's source and each member is looked for in the three
 * switches. A source scan that finds nothing passes vacuously, so the parsed
 * union is asserted non-empty first - the failure mode CLAUDE.md records from
 * the CSS-import guard that spent weeks reading `""`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function read(path: string): string {
	return readFileSync(join(here, path), "utf8");
}

const tabsStore = read("../../stores/tabs-store.ts");
const shell = read("./Shell.tsx");
const tabStrip = read("./TabStrip.tsx");

/** The members of `export type TabType = "a" | "b" | ...`. */
function tabTypes(source: string): string[] {
	const declaration = /export type TabType =([^;]+);/.exec(source);
	if (!declaration) return [];
	return [...declaration[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

describe("TabType coverage", () => {
	const types = tabTypes(tabsStore);

	it("reads a non-empty union out of the store", () => {
		// Without this the three cases below pass on an empty list.
		expect(types.length).toBeGreaterThanOrEqual(7);
		expect(types).toContain("request");
		expect(types).toContain("inbox");
	});

	it("gives every type a branch in Shell's content switch", () => {
		for (const type of types) {
			expect(shell, `Shell.renderTabContent has no case for "${type}"`).toContain(
				`case "${type}":`
			);
		}
	});

	it("gives every type a branch in TabStrip's descriptor switch", () => {
		for (const type of types) {
			expect(tabStrip, `TabStrip has no descriptor case for "${type}"`).toContain(
				`case "${type}":`
			);
		}
	});

	it("gives every type an explicit answer in isTabDirty", () => {
		// The switch runs from `function isTabDirty` to the closing of its
		// `default` branch; reading the whole file would find the same strings in
		// SINGLETON_TYPES and pass regardless.
		const start = tabsStore.indexOf("function isTabDirty");
		const end = tabsStore.indexOf("interface PersistedTabs");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const isTabDirty = tabsStore.slice(start, end);

		// welcome, dashboard and run register no save context at all and are
		// answered by the documented `default`; every other type states itself.
		const viaDefault = ["welcome", "dashboard", "run"];
		for (const type of types.filter((t) => !viaDefault.includes(t))) {
			expect(isTabDirty, `isTabDirty has no case for "${type}"`).toContain(`case "${type}":`);
		}
	});
});
