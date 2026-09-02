/**
 * @vitest-environment jsdom
 */
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
 * name - the Dock's four view switchers all had tooltips and still announced as
 * bare buttons.
 *
 * Nine such buttons had drifted in, sitting beside correctly-labelled ones, so
 * this scans the source rather than testing the handful that existed at the
 * time. A new unnamed icon button anywhere in the app fails this test.
 *
 * A name may come from `aria-label`, `aria-labelledby`, or `title` - all three
 * feed the accessible-name computation, and this codebase uses `title` for it
 * in several places. (title-only is weaker - it does not surface on keyboard
 * focus - but it is a name, and forcing a conversion is a separate decision.)
 */

import { describe, it, expect } from "vitest";
import { openingTags, summarize } from "@/lib/jsx-opening-tags.testkit";

const sources = import.meta.glob("/src/**/*.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
});

const isIconButton = (tag: string) => /size=["']icon["']/.test(tag);

const hasAccessibleName = (tag: string) =>
	/aria-label[=\s]/.test(tag) || /aria-labelledby[=\s]/.test(tag) || /\btitle[=\s]/.test(tag);

describe("icon-only buttons have accessible names", () => {
	const iconTags = Object.entries(sources).flatMap(([path, src]) =>
		openingTags(src as string, "Button")
			.filter(isIconButton)
			.map((tag) => ({ path, tag }))
	);

	it("finds icon buttons to check (guards the scan itself)", () => {
		// A renamed primitive or a broken glob would match nothing, and every
		// assertion below would then vacuously pass. The floor only has to be
		// clear of zero - kept well below the real count so removing a button
		// (e.g. the run header's back button) does not trip the guard.
		expect(iconTags.length).toBeGreaterThan(5);
	});

	it("names every icon-only Button", () => {
		const offenders = iconTags
			.filter(({ tag }) => !hasAccessibleName(tag))
			.map(({ path, tag }) => summarize(path, tag));
		expect(offenders).toEqual([]);
	});
});
