/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Surfaces that reflow at a narrow pane or a 200% interface scale keep the
 * floors that make them (#3494). The window's 1024px minimum is a 512px layout
 * at 200%, and a pane beside the context bar is narrower again.
 *
 * Source scans, because jsdom does no layout and the two surfaces below cost a
 * heavy harness to render (a variables editor with its save queue, the MCP
 * settings panel with its status polling). Comments are stripped first, so a
 * comment that names a class cannot satisfy the guard.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "@/lib/strip-comments.testkit";

const here = dirname(fileURLToPath(import.meta.url));

function code(relPath: string): string {
	const source = stripComments(readFileSync(join(here, relPath), "utf8"));
	// A guard over an empty read passes forever.
	expect(source.length).toBeGreaterThan(300);
	return source;
}

describe("the variables table", () => {
	const source = code("modules/variables/main/VariableTableEditor.tsx");

	it("gives the Value column a floor, so a narrow pane scrolls instead of squeezing it", () => {
		expect(source).toMatch(/<th className="[^"]*\bmin-w-\[10rem\][^"]*">Value<\/th>/);
		expect(source).toMatch(/<th className="[^"]*\bmin-w-\[8rem\][^"]*">Variable<\/th>/);
	});
});

describe("the MCP settings panel's snippet header", () => {
	const source = code("modules/settings/main/panels/McpSettingsPanel.tsx");

	it("wraps its label and its buttons rather than overflowing the pane", () => {
		expect(source).toMatch(
			/<div className="flex flex-wrap items-center justify-between[^"]*">\s*<span className="min-w-0 /
		);
	});
});
