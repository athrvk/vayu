/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Motion has to stop for a user who already asked their operating system to
 * stop it.
 *
 * Vayu shipped with a Reduced motion toggle in Settings → Appearance and
 * nothing else — so someone who had turned Reduce Motion on in Windows, macOS
 * or GNOME still got every animation until they found a checkbox in this app
 * and said it a second time. `prefers-reduced-motion` appeared nowhere in the
 * stylesheet.
 *
 * The two rules are additive and must stay in step: the attribute rule is the
 * in-app toggle, the media rule is the system preference, and both collapse the
 * same four properties. A declaration added to one and forgotten in the other
 * would leave the system-preference path animating something the toggle stops.
 *
 * Read from disk rather than imported: vitest stubs CSS imports to an empty
 * string unless `test.css` is enabled, so `import css from "…?raw"` and the
 * `import.meta.glob` equivalent both hand back "" — and every assertion here
 * would have passed against nothing.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

const COLLAPSED = [
	"animation-duration: 0.01ms !important",
	"animation-iteration-count: 1 !important",
	"transition-duration: 0.01ms !important",
	"scroll-behavior: auto !important",
];

/** The block a selector opens, so the two rules can be compared separately. */
function ruleBlock(needle: string): string {
	const at = css.indexOf(needle);
	expect(at, `expected to find ${needle} in index.css`).toBeGreaterThan(-1);
	const open = css.indexOf("{", at);
	return css.slice(open, css.indexOf("}", open) + 1);
}

describe("reduced motion", () => {
	it("reads a stylesheet that is actually there (guards the scan itself)", () => {
		expect(css.length).toBeGreaterThan(1000);
	});

	it("honours the system preference, not only the in-app toggle", () => {
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
	});

	it("collapses the same properties from the system preference as from the toggle", () => {
		const media = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
		const toggle = ruleBlock('html[data-reduced-motion="true"]');
		for (const decl of COLLAPSED) {
			expect(toggle, `toggle rule should collapse ${decl}`).toContain(decl);
			expect(media.slice(0, 500), `system-preference rule should collapse ${decl}`).toContain(
				decl
			);
		}
	});

	it("applies to pseudo-elements too, which carry their own animations", () => {
		const head = css
			.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))
			.slice(0, 300);
		expect(head).toContain("*::before");
		expect(head).toContain("*::after");
	});
});
