/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { rowInsetPx } from "@/constants/layout";
import { treeGuideStyle } from "./tree-guide-style";

const ACCENT = "hsl(var(--primary) / 0.5)";

/** A style's comma-separated layer list as an array, at the top level of any `calc(...)`. */
function layers(value: unknown): string[] {
	const parts: string[] = [];
	let current = "";
	let nesting = 0;
	for (const char of String(value)) {
		if (char === "(") nesting++;
		if (char === ")") nesting--;
		if (char === "," && nesting === 0) {
			parts.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

/** Where a level's guide sits: the centre of that level's chevron. */
const positionOf = (level: number) => `calc(${rowInsetPx(level)}px + var(--spacing-target) / 2) 0`;

describe("treeGuideStyle", () => {
	it("draws nothing for a root row, which has no ancestors", () => {
		expect(treeGuideStyle(0, null)).toEqual({});
	});

	it("draws one divider line per ancestor level, at that level's chevron centre", () => {
		const style = treeGuideStyle(3, null);

		expect(layers(style.backgroundPosition)).toEqual([0, 1, 2].map(positionOf));
		expect(layers(style.backgroundImage)).toEqual(
			Array(3).fill("linear-gradient(var(--rule), var(--rule))")
		);
		expect(layers(style.backgroundSize)).toEqual(Array(3).fill("1px 100%"));
		expect(style.backgroundRepeat).toBe("no-repeat");
	});

	it("adds exactly one accent layer, at the active level, over the divider lines", () => {
		const style = treeGuideStyle(3, 1);

		const images = layers(style.backgroundImage);
		expect(images).toHaveLength(4);
		expect(images.filter((image) => image.includes(ACCENT))).toHaveLength(1);
		// First in the list is topmost.
		expect(images[0]).toBe(`linear-gradient(${ACCENT}, ${ACCENT})`);
		expect(layers(style.backgroundPosition)).toEqual([1, 0, 1, 2].map(positionOf));
		expect(layers(style.backgroundSize)).toEqual(Array(4).fill("1px 100%"));
	});

	it("ignores an active level the row has no guide for", () => {
		expect(treeGuideStyle(1, 1)).toEqual(treeGuideStyle(1, null));
		expect(treeGuideStyle(0, 0)).toEqual({});
	});

	it("sizes every layer to the gap strip for a wrapper, and paints none without a gap", () => {
		const style = treeGuideStyle(2, 0, 0.5);

		expect(layers(style.backgroundSize)).toEqual(
			Array(3).fill("1px calc(var(--spacing) * 0.5)")
		);
		expect(layers(style.backgroundPosition)).toEqual([0, 0, 1].map(positionOf));
		expect(treeGuideStyle(2, 0, 0)).toEqual({});
	});
});
