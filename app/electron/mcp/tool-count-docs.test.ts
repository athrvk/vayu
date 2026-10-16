/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tool-count-docs.test.ts
 * @brief Holds every published tool, resource and prompt count to the registry.
 *
 * The registry has grown by tools, never by a page edit: `README.md` said "24
 * typed tools" until it held 68, and `docs/index.md` and the Bruno comparison
 * were still on 49 and 24 after that (#1431). Nothing re-checked the figure,
 * because a number in prose is not code and no build reads it.
 *
 * The rule this enforces: a digit that immediately precedes "tools" names the
 * whole registry. A count of some *part* of it is written in words - as
 * "Eight tools carry it" already is in `docs/engine/mcp.md` - so a subset does
 * not need an exception here and cannot be mistaken for the total.
 *
 * Resources and prompts follow the same rule (#2108): `docs/index.md` said "5
 * resources" after the registry held eight static ones and a templated run
 * report. The resource total is the static list plus that one template.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOC_READING_GUARDS, ROOT_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { PROMPTS } from "./prompts.js";
import { STATIC_RESOURCES } from "./resources.js";
import { TOOLS } from "./tools.js";

/** Every page that states how many tools the MCP server exposes. */
const PAGES = [...DOC_READING_GUARDS.mcpToolCount.paths, ...ROOT_READING_GUARDS.mcpToolCount.paths];

/** "68 tools", "68 typed tools" - the shape a page states the total in. */
const COUNT = /(\d+)\s+(?:typed\s+)?tools\b/g;

/** "9 resources", "4 prompts" - the same shape, for the other two registries. */
const RESOURCE_COUNT = /(\d+)\s+resources\b/g;
const PROMPT_COUNT = /(\d+)\s+prompts\b/g;

/** The templated `vayu://run/{runId}/report` is listed beside the static ones. */
const TEMPLATED_RESOURCES = 1;

describe("published tool counts", () => {
	/*
	 * A scan that matched nothing passes forever, including the day a stale
	 * count is written back in. Three is what the pages carry between them
	 * today; a page that states no count is still listed, so that it is covered
	 * from the moment it gains one.
	 */
	it("reads pages that actually state a count", () => {
		const stated = PAGES.flatMap((page) => [
			...readFileSync(fromRepoRoot(page), "utf8").matchAll(COUNT),
		]);
		expect(stated.length).toBeGreaterThanOrEqual(3);
	});

	it.each(PAGES)("%s states no count the registry disagrees with", (page) => {
		const text = readFileSync(fromRepoRoot(page), "utf8");
		expect(text.length).toBeGreaterThan(0);

		for (const [, count] of text.matchAll(COUNT)) {
			expect(Number(count)).toBe(TOOLS.length);
		}
	});
});

describe("published resource and prompt counts", () => {
	const read = (page: string) => readFileSync(fromRepoRoot(page), "utf8");
	const statements = (pattern: RegExp) =>
		PAGES.flatMap((page) => [...read(page).matchAll(pattern)].map((m) => Number(m[1])));

	it("reads pages that actually state a resource count and a prompt count", () => {
		expect(statements(RESOURCE_COUNT).length).toBeGreaterThanOrEqual(1);
		expect(statements(PROMPT_COUNT).length).toBeGreaterThanOrEqual(1);
	});

	it("states the number of resources the server lists", () => {
		for (const count of statements(RESOURCE_COUNT)) {
			expect(count).toBe(STATIC_RESOURCES.length + TEMPLATED_RESOURCES);
		}
	});

	it("states the number of prompts the server lists", () => {
		for (const count of statements(PROMPT_COUNT)) {
			expect(count).toBe(PROMPTS.length);
		}
	});
});

describe("the published write roster", () => {
	const text = readFileSync(fromRepoRoot("docs/engine/mcp.md"), "utf8");
	// The sentence between the rule and the first thing the category does not gate.
	const roster = text.match(
		/declared `category: "write"` in `tools\/\*\.tools\.ts`([\s\S]*?)Does not gate/
	);

	it("names exactly the tools declared category: write", () => {
		expect(roster).not.toBeNull();
		const named = [...(roster?.[1] ?? "").matchAll(/`([a-z_0-9]+)`/g)].map((m) => m[1]);
		const declared = TOOLS.filter((t) => t.category === "write").map((t) => t.name);

		expect(declared.length).toBeGreaterThan(20);
		expect(named.sort()).toEqual(declared.sort());
	});

	it("states the count of write tools", () => {
		const declared = TOOLS.filter((t) => t.category === "write").length;
		expect(roster?.[1]).toContain(`${declared} write tools`);
	});
});
