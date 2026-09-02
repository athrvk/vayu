/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A decoration class `index.css` does not declare paints nothing at all, and
 * nothing else in the app would notice: Monaco takes the class name as a
 * string, attaches it, and the token stays the theme's colour.
 *
 * Read from disk rather than imported: vitest stubs a CSS import to `""`, and a
 * guard that scans an empty string passes while proving nothing (repo
 * CLAUDE.md) - hence the non-empty assertion first.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { VARIABLE_TOKEN_CLASSES } from "@/lib/monaco-variable-tokens";

const indexCss = readFileSync(new URL("../../../index.css", import.meta.url), "utf8");

describe("the Monaco variable-token classes", () => {
	it("scanned a stylesheet, and a non-empty list of classes", () => {
		expect(indexCss.length).toBeGreaterThan(1000);
		expect(VARIABLE_TOKEN_CLASSES.length).toBeGreaterThan(0);
	});

	it("are all declared, under `.monaco-editor` so Monaco's own theme cannot win", () => {
		// Two classes beat the one-class `.mtk*` rules Monaco injects at runtime,
		// whichever stylesheet loads last - which is the whole reason for the
		// prefix in the selector.
		for (const cls of VARIABLE_TOKEN_CLASSES) {
			expect(indexCss).toContain(`.monaco-editor .${cls}`);
		}
	});
});
