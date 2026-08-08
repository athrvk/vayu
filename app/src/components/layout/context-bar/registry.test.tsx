/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The registry is the single answer to "does the bar have anything to show?".
 *
 * Two surfaces used to answer it separately - a hardcoded `tabType ===
 * "request"` in `context-bar-content.ts` and a `return null` inside the bar -
 * and keeping them in step was manual. The Dock's pressed state now reads the
 * registry through `contextBarHasContent`, so a Phase 2 section added for
 * collection tabs lights the toggle there with no second edit. This file pins
 * that derivation: change the predicate back to a literal tab type and the last
 * case here reddens.
 */

import { describe, it, expect } from "vitest";
import { CONTEXT_BAR_SECTIONS, sectionsForTab } from "./registry";
import { contextBarHasContent } from "../context-bar-content";
import type { Tab, TabType } from "@/stores";

const ENTITY_TYPES: TabType[] = ["request", "collection", "run"];

/**
 * The tab types whose sections are gated on the tab being open on something -
 * `appliesTo` in the registry. The request tab predates that gate and is
 * deliberately left as it was: `Shell` shows the welcome screen for one with no
 * entity, and narrowing it is not this change's business.
 */
const ENTITY_GATED_TYPES: TabType[] = ["collection", "run"];

const tab = (type: TabType): Tab => ({
	id: "t1",
	type,
	entityId: ENTITY_TYPES.includes(type) ? `${type}_1` : null,
});

/** The same tab, but never opened on anything - see `appliesTo` in the registry. */
const entitylessTab = (type: TabType): Tab => ({ id: "t1", type, entityId: null });

const OTHER_TYPES: TabType[] = ["welcome", "dashboard", "variables", "settings"];

describe("the context-bar section registry", () => {
	it("ships the Phase 1 sections for a request tab, in reading order", () => {
		expect(sectionsForTab(tab("request")).map((s) => s.id)).toEqual([
			"variables",
			"auth",
			"cookies",
			"code",
			"environment",
		]);
	});

	it("ships the collection sections for a collection tab, in reading order", () => {
		expect(sectionsForTab(tab("collection")).map((s) => s.id)).toEqual([
			"collection-variables",
			"collection-auth",
			"collection-contents",
		]);
	});

	it("ships the run sections for a run tab, in reading order", () => {
		expect(sectionsForTab(tab("run")).map((s) => s.id)).toEqual(["run-config", "run-source"]);
	});

	it("has nothing for a collection or run tab that is not on an entity", () => {
		// `Shell` renders no pane for one of these either. A section here would
		// query nothing and light the Dock toggle over an empty bar.
		expect(sectionsForTab(entitylessTab("collection"))).toEqual([]);
		expect(sectionsForTab(entitylessTab("run"))).toEqual([]);
	});

	it("has no collection-run section, which nothing in the app can answer yet", () => {
		// A collection has no runs of its own until the collection runner (#354)
		// exists; a section claiming one could only invent it.
		expect(CONTEXT_BAR_SECTIONS.map((s) => s.id)).not.toContain("collection-last-run");
	});

	it("has no last-result section, which the response pane already is", () => {
		// `ResponseStatusBar` paints the same status chip, duration and age in
		// the response pane on the same screen, from the same stored run - so a
		// section here could only ever be a poorer copy of it. Re-adding one is
		// the regression this guards; the trend version (#380) is a different
		// section with a different id.
		expect(CONTEXT_BAR_SECTIONS.map((s) => s.id)).not.toContain("last-result");
	});

	it("gives every section a unique id, since the id is the persisted key", () => {
		const ids = CONTEXT_BAR_SECTIONS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("gives every section a title and a component", () => {
		for (const section of CONTEXT_BAR_SECTIONS) {
			expect(section.title.length).toBeGreaterThan(0);
			expect(typeof section.Component).toBe("function");
		}
	});

	it("has no sections for the four tab types that deliberately show nothing", () => {
		for (const type of OTHER_TYPES) {
			expect(sectionsForTab(tab(type))).toEqual([]);
		}
	});

	it("has none for no tab at all", () => {
		expect(sectionsForTab(undefined)).toEqual([]);
	});
});

describe("contextBarHasContent reads the registry", () => {
	it("is true exactly where the registry has sections", () => {
		for (const type of ENTITY_TYPES) {
			expect(contextBarHasContent(tab(type))).toBe(true);
		}
		for (const type of ENTITY_GATED_TYPES) {
			expect(contextBarHasContent(entitylessTab(type))).toBe(false);
		}
		for (const type of OTHER_TYPES) {
			expect(contextBarHasContent(tab(type))).toBe(false);
		}
		expect(contextBarHasContent(undefined)).toBe(false);
	});

	it("agrees with the registry rather than restating it", () => {
		// The derivation, not the current answer: every tab type is checked
		// against `sectionsForTab` itself, so a hardcoded predicate that happens
		// to match today would still fail the moment the two disagree.
		for (const type of [...OTHER_TYPES, ...ENTITY_TYPES]) {
			for (const t of [tab(type), entitylessTab(type)]) {
				expect(contextBarHasContent(t)).toBe(sectionsForTab(t).length > 0);
			}
		}
	});
});
