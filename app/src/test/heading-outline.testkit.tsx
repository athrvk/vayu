/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a tab's main pane owes a screen-reader user (#3498): one top-level
 * heading naming it, and headings below it that never skip a level - axe's
 * `heading-order`, and what heading navigation reads as the pane's outline.
 *
 * `asTab` is the outline the Shell opens around the active tab
 * (`HeadingSection level={1}` in `Shell.tsx`); a test that renders a tab root
 * on its own wraps it in this so the root's headings level as they do on
 * screen.
 */

import type { ReactElement, ReactNode } from "react";
import { expect } from "vitest";
import { HeadingSection } from "@/components/ui/heading";

export function asTab(ui: ReactNode): ReactElement {
	return <HeadingSection level={1}>{ui}</HeadingSection>;
}

/** Every heading under `root`, as its level and text, in document order. */
export function headingOutline(root: ParentNode): { level: number; text: string }[] {
	return Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"), (h) => ({
		level: Number(h.tagName[1]),
		text: h.textContent?.trim() ?? "",
	}));
}

/**
 * Exactly one `h1`, it comes first, and each heading after it is at most one
 * level deeper than the one before. Returns the `h1`'s text so the caller can
 * say which title it expected.
 */
export function expectOneTopHeading(root: ParentNode): string {
	const outline = headingOutline(root);
	const tops = outline.filter((h) => h.level === 1);
	expect(tops, JSON.stringify(outline)).toHaveLength(1);
	expect(outline[0].level, JSON.stringify(outline)).toBe(1);
	const skips = outline.filter((h, i) => i > 0 && h.level > outline[i - 1].level + 1);
	expect(skips, JSON.stringify(outline)).toEqual([]);
	return tops[0].text;
}
