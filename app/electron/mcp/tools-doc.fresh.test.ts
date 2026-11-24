/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tools-doc.fresh.test.ts
 * @brief Holds `docs/engine/mcp/tools.md` equal to what the tool registry renders.
 *
 * The table and the count the docs state are derived, so a tool added to the
 * registry changes this page and no prose page. A tool's title, category or
 * hints edited in a `*.tools.ts` file, or a page edited by hand, fails here
 * with the command that rewrites it. `pnpm docs:mcp-tools` runs this file with
 * `UPDATE_TOOLS_DOC=1`, which writes the page instead of comparing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOC_READING_GUARDS, entryCovers, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { TOOLS_DOC_PATH, renderToolsDoc } from "./tools-doc.testkit";
import { TOOLS } from "./tools.js";

const REGENERATE = "pnpm docs:mcp-tools";

describe("the generated MCP tools page", () => {
	it("is the page the guard registry routes", () => {
		const routed = DOC_READING_GUARDS.mcpToolsDoc.paths.some((entry) =>
			entryCovers(entry, TOOLS_DOC_PATH)
		);
		expect(routed).toBe(true);
	});

	it("equals what the tool registry renders", () => {
		const rendered = renderToolsDoc();
		const path = fromRepoRoot(TOOLS_DOC_PATH);

		if (process.env.UPDATE_TOOLS_DOC === "1") writeFileSync(path, rendered);

		const committed = readFileSync(path, "utf8");
		expect(
			committed === rendered,
			`${TOOLS_DOC_PATH} is generated from the tool registry and is out of date. ` +
				`Run \`${REGENERATE}\` from app/ and commit the result; do not edit the page by hand.`
		).toBe(true);
	});

	it("lists every registered tool once, sorted by name", () => {
		const names = [...renderToolsDoc().matchAll(/^\| `([a-z_0-9]+)` \|/gm)].map((m) => m[1]);

		expect(names).toHaveLength(TOOLS.length);
		expect(names).toEqual(TOOLS.map((tool) => tool.name).sort());
	});
});
