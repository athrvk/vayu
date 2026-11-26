/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tool-count-docs.test.ts
 * @brief Keeps every published tool, resource and prompt count in one place.
 *
 * The registry has grown by tools, never by a page edit: `README.md` said "24
 * typed tools" until it held 68, and `docs/index.md` and the Bruno comparison
 * were still on 49 and 24 after that (#1431). Nothing re-checked the figure,
 * because a number in prose is not code and no build reads it, and two pull
 * requests that each wrote the next digit merged cleanly and were both wrong.
 *
 * So no page states a count except the generated `docs/engine/mcp/tools.md`
 * (#3848), whose one count line is rendered from the registries and held equal
 * to them by `tools-doc.fresh.test.ts`. This file holds every other page free
 * of one, and the generated line to what the registries hold. A count of some
 * *part* of the registry is written in words ("Eight tools carry it"), so a
 * subset cannot be mistaken for the total. The write roster in `safety.md` is a
 * list the registry derives, checked below.
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOC_READING_GUARDS, ROOT_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { PROMPTS } from "./prompts.js";
import { STATIC_RESOURCES } from "./resources.js";
import { TEMPLATED_RESOURCES, TOOLS_DOC_PATH, countLine } from "./tools-doc.testkit";
import { TOOLS } from "./tools.js";

/** A registry entry, as the pages it names: a directory entry is every Markdown page in it. */
function pagesOf(entry: string): string[] {
	if (!entry.endsWith("/")) return [entry];
	return readdirSync(fromRepoRoot(entry))
		.filter((name) => name.endsWith(".md"))
		.map((name) => `${entry}${name}`);
}

/** Every page that could state how many tools the MCP server exposes. */
const PAGES = [...DOC_READING_GUARDS.mcpToolCount.paths, ...ROOT_READING_GUARDS.mcpToolCount.paths]
	.flatMap(pagesOf)
	.sort();

const read = (page: string) => readFileSync(fromRepoRoot(page), "utf8");

/** "68 tools", "68 typed tools", "9 resources", "4 prompts" - the shapes a page states a total in. */
const COUNT = /\d+\s+(?:typed\s+)?(?:tools|resources|prompts)\b/g;

/** A page's text without its generated count line. */
const withoutCountLine = (text: string) => text.replace(countLine(), "");

describe("published counts", () => {
	/*
	 * A scan that read nothing passes forever, including the day a count is
	 * written back in. The floor is the pages the registry names today: the
	 * four docs pages and the README, and the directory's own pages.
	 */
	it("reads the pages, the MCP directory's among them", () => {
		expect(PAGES.length).toBeGreaterThanOrEqual(10);
		expect(PAGES).toContain(TOOLS_DOC_PATH);
		expect(PAGES).toContain("README.md");
	});

	it.each(PAGES)("%s states no tool, resource or prompt count", (page) => {
		const text = withoutCountLine(read(page));
		expect(text.length).toBeGreaterThan(0);
		expect([...text.matchAll(COUNT)].map((m) => m[0])).toEqual([]);
	});

	it("states each total once, on the generated page, as the registries hold it", () => {
		const text = read(TOOLS_DOC_PATH);
		const lines = [...text.matchAll(/\*\*(\d+) tools, (\d+) resources, (\d+) prompts\.\*\*/g)];

		expect(lines).toHaveLength(1);
		expect(lines[0].slice(1).map(Number)).toEqual([
			TOOLS.length,
			STATIC_RESOURCES.length + TEMPLATED_RESOURCES,
			PROMPTS.length,
		]);
	});
});

describe("the published write roster", () => {
	const text = read("docs/engine/mcp/safety.md");
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
