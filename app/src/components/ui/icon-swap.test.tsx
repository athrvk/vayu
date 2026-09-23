/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Check, Copy } from "lucide-react";

import { IconSwap } from "./icon-swap";

const ICONS = {
	copy: <Copy data-testid="copy" className="w-3.5 h-3.5" />,
	copied: <Check data-testid="check" className="w-3.5 h-3.5" />,
} as const;

describe("IconSwap", () => {
	it("puts the live icon in the .enter-fade cell", () => {
		const { container } = render(<IconSwap state="copy" icons={ICONS} />);
		const live = container.querySelector(".enter-fade");
		expect(live).not.toBeNull();
		expect(live!.querySelector(".lucide-copy")).not.toBeNull();
		// Mutation check: drop `enter-fade` from the live span in
		// `icon-swap.tsx` and this fails - the swap would then be instant.
		expect(live).toHaveClass("col-start-1", "row-start-1");
	});

	it("re-keys the live span on a state change, so .enter-fade fires again", () => {
		const { container, rerender } = render(<IconSwap state="copy" icons={ICONS} />);
		const before = container.querySelector(".enter-fade");
		rerender(<IconSwap state="copied" icons={ICONS} />);
		const after = container.querySelector(".enter-fade");
		expect(after).not.toBeNull();
		expect(after).not.toBe(before);
		expect(after!.querySelector(".lucide-check")).not.toBeNull();
	});

	it("re-keys on the way back too - a round trip fades both directions", () => {
		const { container, rerender } = render(<IconSwap state="copy" icons={ICONS} />);
		let previous = container.querySelector(".enter-fade");
		const seen = new Set<Element>([previous!]);
		for (const state of ["copied", "copy", "copied", "copy"] as const) {
			rerender(<IconSwap state={state} icons={ICONS} />);
			const current = container.querySelector(".enter-fade");
			expect(current, `no live span after switching to "${state}"`).not.toBeNull();
			expect(current, `"${state}" reused the previous node`).not.toBe(previous);
			expect(seen.has(current!), `"${state}" reused a node from an earlier step`).toBe(false);
			seen.add(current!);
			previous = current;
		}
	});

	it("reserves a height-zero, aria-hidden twin for every state, live one included", () => {
		const { container } = render(<IconSwap state="copy" icons={ICONS} />);
		// Scoped to `span`: a lucide glyph sets `aria-hidden` on its own `<svg>`,
		// so a bare attribute query counts the icons as well as the twins.
		const twins = container.querySelectorAll('span[aria-hidden="true"]');
		// One per key, not one per *other* key: the box must be sized the same
		// whichever state is live, so the live state keeps its reserve too.
		expect(twins).toHaveLength(2);
		for (const twin of twins) {
			expect(twin).toHaveClass("invisible", "h-0", "col-start-1", "row-start-1");
		}
	});

	it("never replaces a reserve twin when the live icon changes", () => {
		const { container, rerender } = render(<IconSwap state="copy" icons={ICONS} />);
		const initial = [...container.querySelectorAll('span[aria-hidden="true"]')];
		expect(initial).toHaveLength(2);
		rerender(<IconSwap state="copied" icons={ICONS} />);
		const twins = [...container.querySelectorAll('span[aria-hidden="true"]')];
		expect(twins).toHaveLength(2);
		// Element-wise `toBe`: `toEqual` on DOM nodes compares structurally and
		// would pass even after a twin was silently swapped out.
		twins.forEach((twin, i) => expect(twin, `twin ${i} was replaced`).toBe(initial[i]));
	});

	it("renders both glyphs, so the box is sized by the larger of the pair", () => {
		const { container } = render(<IconSwap state="copy" icons={ICONS} />);
		// jsdom has no layout, so the reservation is asserted as its mechanism -
		// both glyphs present in one grid cell - not as a measured width.
		expect(container.querySelectorAll(".lucide-copy")).toHaveLength(2);
		expect(container.querySelectorAll(".lucide-check")).toHaveLength(1);
	});

	it("adds nothing to the caller's icon, so a motion on it survives the swap", () => {
		// `data-icon-motion` and IconSwap are separate mechanisms (#1685, #1686):
		// the swap passes the node through, so an icon can hinge on hover and
		// still crossfade on a state change.
		const { container } = render(
			<IconSwap
				state="copy"
				icons={{ copy: <Copy data-icon-motion="rotate-90" />, copied: <Check /> }}
			/>
		);
		const live = container.querySelector(".enter-fade > svg");
		expect(live).toHaveAttribute("data-icon-motion", "rotate-90");
	});

	it("takes a className for the grid wrapper without losing the grid", () => {
		const { container } = render(<IconSwap state="copy" icons={ICONS} className="mr-1.5" />);
		const wrapper = container.firstElementChild!;
		expect(wrapper).toHaveClass("grid", "mr-1.5");
	});
});
