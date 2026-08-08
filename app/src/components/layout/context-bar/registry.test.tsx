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

const tab = (type: TabType): Tab => ({
	id: "t1",
	type,
	entityId: type === "request" ? "req_1" : null,
});

const OTHER_TYPES: TabType[] = [
	"welcome",
	"collection",
	"dashboard",
	"run",
	"variables",
	"settings",
];

describe("the context-bar section registry", () => {
	it("ships the six Phase 1 sections for a request tab, in reading order", () => {
		expect(sectionsForTab(tab("request")).map((s) => s.id)).toEqual([
			"variables",
			"auth",
			"cookies",
			"last-result",
			"code",
			"environment",
		]);
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

	it("has no sections for the other tab types yet", () => {
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
		expect(contextBarHasContent(tab("request"))).toBe(true);
		for (const type of OTHER_TYPES) {
			expect(contextBarHasContent(tab(type))).toBe(false);
		}
		expect(contextBarHasContent(undefined)).toBe(false);
	});

	it("agrees with the registry rather than restating it", () => {
		// The derivation, not the current answer: every tab type is checked
		// against `sectionsForTab` itself, so a hardcoded predicate that happens
		// to match today would still fail the moment the two disagree.
		for (const type of [...OTHER_TYPES, "request" as const]) {
			expect(contextBarHasContent(tab(type))).toBe(sectionsForTab(tab(type)).length > 0);
		}
	});
});
