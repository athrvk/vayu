/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Icon-only buttons must carry an accessible name.
 *
 * An icon-only button has no text node, so without one a screen reader
 * announces nothing but "button". A tooltip does not fix this: Radix supplies
 * `aria-describedby` while the tooltip is open, which is a *description*, not a
 * name — the Dock's four view switchers all had tooltips and still announced as
 * bare buttons.
 *
 * Nine such buttons had drifted in, sitting beside correctly-labelled ones, so
 * this scans the source rather than testing the handful that existed at the
 * time. A new unnamed icon button anywhere in the app fails this test.
 *
 * A name may come from `aria-label`, `aria-labelledby`, or `title` — all three
 * feed the accessible-name computation, and this codebase uses `title` for it
 * in several places. (title-only is weaker — it does not surface on keyboard
 * focus — but it is a name, and forcing a conversion is a separate decision.)
 */

import { describe, it, expect } from "vitest";

const sources = import.meta.glob("/src/**/*.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
});

/**
 * Extract complete `<Button ...>` opening tags. A regex cannot do this: JSX
 * props hold arrow functions (`onClick={(e) => …}`) and object literals whose
 * `>` and `}` would end the match early — which is exactly the bug that made an
 * earlier version of this test flag already-labelled buttons. So scan with a
 * brace/string-aware cursor and end the tag only at a top-level `>`.
 */
function buttonOpeningTags(src: string): string[] {
	const tags: string[] = [];
	const re = /<Button\b/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		let depth = 0; // {} nesting
		let quote: string | null = null;
		let i = m.index + m[0].length;
		for (; i < src.length; i++) {
			const c = src[i];
			if (quote) {
				if (c === quote) quote = null;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") quote = c;
			else if (c === "{") depth++;
			else if (c === "}") depth--;
			else if (c === ">" && depth === 0) break;
		}
		tags.push(src.slice(m.index, i + 1));
	}
	return tags;
}

const isIconButton = (tag: string) => /size=["']icon["']/.test(tag);

const hasAccessibleName = (tag: string) =>
	/aria-label[=\s]/.test(tag) || /aria-labelledby[=\s]/.test(tag) || /\btitle[=\s]/.test(tag);

describe("icon-only buttons have accessible names", () => {
	const iconTags = Object.entries(sources).flatMap(([path, src]) =>
		buttonOpeningTags(src as string)
			.filter(isIconButton)
			.map((tag) => ({ path, tag }))
	);

	it("finds icon buttons to check (guards the scan itself)", () => {
		// A renamed primitive or a broken glob would match nothing, and every
		// assertion below would then vacuously pass.
		expect(iconTags.length).toBeGreaterThan(10);
	});

	it("names every icon-only Button", () => {
		const offenders = iconTags
			.filter(({ tag }) => !hasAccessibleName(tag))
			.map(({ path, tag }) => `${path}: ${tag.replace(/\s+/g, " ").slice(0, 90)}`);
		expect(offenders).toEqual([]);
	});
});
