/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two call sites already assert that the pane appears while their query is
 * in flight. What they cannot see is the placeholder's own contract: the bars
 * are decoration and must not reach the accessibility tree, or a screen reader
 * reads out a fake heading and four fake rows before the real content arrives.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DetailSkeleton } from "./DetailSkeleton";

describe("DetailSkeleton", () => {
	it("announces the pane once and hides the bars", () => {
		const { container } = render(<DetailSkeleton label="Loading collection" />);
		expect(screen.getByRole("status", { name: "Loading collection" })).toBeInTheDocument();
		// Every bar sits under one aria-hidden wrapper, so the label is the only
		// thing announced.
		const hidden = container.querySelector('[aria-hidden="true"]');
		expect(hidden).not.toBeNull();
		expect(container.querySelectorAll('[aria-hidden="true"] > *').length).toBeGreaterThan(0);
	});

	it("draws the number of rows asked for", () => {
		const rowsOf = (n: number) => {
			const { container, unmount } = render(<DetailSkeleton label="Loading" rows={n} />);
			// The heading and subtitle bars are siblings of the row stack, so count
			// only the stack's children.
			const stack = container.querySelectorAll('[aria-hidden="true"] > div > *').length;
			unmount();
			return stack;
		};
		expect(rowsOf(4)).toBe(4);
		expect(rowsOf(7)).toBe(7);
	});
});
