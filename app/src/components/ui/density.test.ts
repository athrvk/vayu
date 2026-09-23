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
		// setting should move - unlike --tabstrip-height, which reads the
		// `band` floor (see the next assertion) rather than the spacing unit.
		expect(css).toMatch(/--titlebar-height:\s*32px;/);
	});

	it("derives --tabstrip-height from the band floor, not the spacing unit", () => {
		// Issue #1679: this used to be `calc(var(--spacing) * 8)`, which
		// shrank the tab strip to 24px at Default - a chrome band is an
		// anchor, not a list row, and must not scale with density.
		expect(css).toMatch(/--tabstrip-height:\s*var\(--spacing-band\);/);
	});

	// Issue #1679: named floor steps, outside the --spacing multiplier -
	// nine of them since #1688 added the two wider chrome bands -
	// see the "Chrome, Target and Icon Floors" table in docs/design-system.md
	// and design-system-doc.test.ts, which checks that doc's numbers against
	// these same declarations.
	describe("chrome/target/icon floors", () => {
		// A plain `@theme { }` block, deliberately not `@theme inline` - see
		// index.css's own comment on why: `inline` bakes the resolved value
		// into each utility instead of a `var()` reference, which silently
		// disables the Comfortable override below. `indexOf("@theme {")`
		// (with the space) skips past the earlier `@theme inline {` block on
		// purpose.
		const themeOpen = css.indexOf("@theme {");
		const themeClose = css.indexOf("\n}", themeOpen);
		const theme = css.slice(themeOpen, themeClose);

		it("declares all nine steps in a plain @theme block, as literal px", () => {
			expect(themeOpen).toBeGreaterThan(-1);
			for (const [name, px] of [
				["--spacing-band", 32],
				["--spacing-band-md", 40],
				["--spacing-band-lg", 52],
				["--spacing-banner", 36],
				["--spacing-control", 28],
				["--spacing-control-sm", 24],
				["--spacing-target", 24],
				["--spacing-icon", 16],
				["--spacing-icon-sm", 12],
			] as const) {
				expect(theme, name).toMatch(new RegExp(`${name}:\\s*${px}px;`));
			}
		});

		it("is not the @theme inline block, so the utility keeps a var() reference", () => {
			// Confirmed by compiling this exact file with @tailwindcss/node:
			// inside `@theme inline`, `.h-control` compiled to a baked
			// `height: 28px` literal with no `--spacing-control` even emitted
			// to `:root`, which is what silently disabled every override
			// below. A plain `@theme` block keeps the `var()` indirection.
			const inlineOpen = css.indexOf("@theme inline {");
			const inlineClose = css.indexOf("\n}", inlineOpen);
			expect(themeOpen, "the floor block was not found").toBeGreaterThan(-1);
			expect(
				themeOpen < inlineOpen || themeOpen > inlineClose,
				"the floor steps must not be declared inside @theme inline"
			).toBe(true);
		});

		it("never expresses a floor step as calc(var(--spacing) * n)", () => {
			// The whole point of a floor is that it does not ride the rhythm
			// unit - see index.css's own comment on why --tabstrip-height
			// moved off calc(var(--spacing) * 8).
			for (const name of [
				"--spacing-band",
				"--spacing-band-md",
				"--spacing-band-lg",
				"--spacing-banner",
				"--spacing-control",
				"--spacing-control-sm",
				"--spacing-target",
				"--spacing-icon",
				"--spacing-icon-sm",
			]) {
				const declaration = new RegExp(`${name}:\\s*([^;]+);`).exec(theme)?.[1] ?? "";
				expect(declaration, name).not.toMatch(/calc\(var\(--spacing\)/);
			}
		});

		it('scales only control, control-sm and target under [data-density="comfortable"]', () => {
			const comfortableBlock =
				/\[data-density="comfortable"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
			expect(comfortableBlock).toMatch(/--spacing-control:\s*36px;/);
			expect(comfortableBlock).toMatch(/--spacing-control-sm:\s*32px;/);
			expect(comfortableBlock).toMatch(/--spacing-target:\s*28px;/);
			// The three band steps, banner, icon and icon-sm are
			// theme-independent, like --titlebar-height - no override at all
			// under Comfortable.
			for (const name of [
				"--spacing-band",
				"--spacing-band-md",
				"--spacing-band-lg",
				"--spacing-banner",
				"--spacing-icon",
				"--spacing-icon-sm",
			]) {
				expect(comfortableBlock, name).not.toMatch(new RegExp(`${name}:`));
			}
		});
	});
});
