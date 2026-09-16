/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Interface density (issue #1670) is a single CSS custom property,
 * `--spacing`, that every Tailwind `p-*`/`m-*`/`gap-*`/`space-*`/`h-*`/`w-*`
 * utility resolves through (`calc(var(--spacing) * n)`), plus a
 * `[data-density="comfortable"]` override that restores the value Tailwind
 * defaulted to before this variable was declared - today's pre-#1670 layout,
 * unchanged.
 *
 * Source-scanned, not rendered: vitest stubs CSS imports to `""`, so the
 * stylesheet is only readable off disk - hence the non-empty guard below.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "..", "index.css"), "utf8");

describe("interface density", () => {
	it("reads a real stylesheet", () => {
		expect(css.length).toBeGreaterThan(1000);
	});

	it("declares the tightened default on :root", () => {
		// `:root {` opens the base theme block that also declares --radius,
		// --dock-height and --tabstrip-height; scope the search to it so a
		// stray --spacing elsewhere (there is none today) cannot pass this by
		// accident.
		const rootOpen = css.indexOf(":root {");
		expect(rootOpen).toBeGreaterThan(-1);
		const rootClose = css.indexOf("\n\t}", rootOpen);
		const root = css.slice(rootOpen, rootClose);
		expect(root).toMatch(/--spacing:\s*0\.1875rem;/);
	});

	it('restores today\'s roomier unit under [data-density="comfortable"]', () => {
		const m = css.match(/\[data-density="comfortable"\]\s*\{([^}]*)\}/);
		expect(m).not.toBeNull();
		expect(m![1]).toMatch(/--spacing:\s*0\.25rem;/);
	});

	it("keeps --titlebar-height a fixed px value, unaffected by density", () => {
		// Sized to the macOS traffic lights, a platform constant no density
		// setting should move - unlike --tabstrip-height, which is written in
		// the spacing unit deliberately (see the next assertion).
		expect(css).toMatch(/--titlebar-height:\s*32px;/);
	});

	it("derives --tabstrip-height from the spacing unit", () => {
		expect(css).toMatch(/--tabstrip-height:\s*calc\(var\(--spacing\)\s*\*\s*8\);/);
	});
});
