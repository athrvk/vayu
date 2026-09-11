/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `scale` (the Button press-feedback property) has to live in the *same*
 * `transition:` shorthand as the colour properties, not a second rule.
 *
 * A `transition:` shorthand resets every sub-property it doesn't list. An
 * earlier version of this put `scale` in its own `:where([data-slot="button"])`
 * rule, at the same `:where()` specificity (0) as the baseline colour-transition
 * rule and later in the same `@layer base` - so it silently replaced the colour
 * list instead of adding to it, and every Button's hover/press colour change
 * stopped transitioning. Nothing rendered anything wrong in a way a snapshot
 * would catch; the browser just stopped animating.
 *
 * Read from disk rather than imported: vitest stubs CSS imports to an empty
 * string unless `test.css` is enabled - see `reduced-motion.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
const buttonVariants = readFileSync(resolve(__dirname, "./button-variants.ts"), "utf8");

describe("press feedback", () => {
	it("lists scale in the baseline transition alongside the colour properties", () => {
		const at = css.indexOf("transition:\n\t\t\tbackground-color");
		expect(at, "expected the baseline transition shorthand in index.css").toBeGreaterThan(-1);
		const block = css.slice(at, css.indexOf(";", at) + 1);
		expect(block).toContain("scale 100ms ease-out");
	});

	it("does not carry transition-colors on the Button primitive", () => {
		// `@layer utilities` beats the `@layer base` baseline above, so a
		// `transition-colors` utility here would win the cascade and drop
		// `scale` (and the colour transition) from it again. Checked against
		// the actual class-list string, not the whole file - a comment
		// explaining why the class is absent would otherwise trip this.
		const classList = /"inline-flex[^"]*"/.exec(buttonVariants)?.[0];
		expect(classList, "expected the base Button class-list string").toBeTruthy();
		expect(classList).not.toContain("transition-colors");
	});
});
