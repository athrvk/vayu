/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Input } from "./input";

function classes(el: HTMLElement): string[] {
	return el.className.split(/\s+/);
}

describe("Input size", () => {
	it("is the 28px control with no size stated", () => {
		render(<Input aria-label="f" />);
		const list = classes(screen.getByLabelText("f"));
		expect(list).toContain("h-control");
		expect(list).not.toContain("h-control-sm");
		expect(list).not.toContain("h-control-xs");
	});

	it('states the dense control for size="sm"', () => {
		render(<Input aria-label="f" size="sm" />);
		const list = classes(screen.getByLabelText("f"));
		expect(list).toContain("h-control-sm");
		expect(list).not.toContain("h-control");
	});

	it('states the row-field control for size="xs", with its own radius and focus edge', () => {
		render(<Input aria-label="f" size="xs" />);
		const list = classes(screen.getByLabelText("f"));
		expect(list).toContain("h-control-xs");
		expect(list).not.toContain("h-control");
		expect(list).toContain("rounded-sm");
		// One edge draws on focus: the border takes the colour, the ring is off.
		expect(list).toContain("focus-visible:border-ring");
		expect(list).toContain("focus-visible:ring-0");
		expect(list).not.toContain("focus-visible:ring-1");
	});

	it("keeps the ring on focus for the two standalone sizes", () => {
		for (const size of [undefined, "sm"] as const) {
			const { unmount } = render(<Input aria-label="f" size={size} />);
			expect(classes(screen.getByLabelText("f"))).toContain("focus-visible:ring-1");
			unmount();
		}
	});

	it("pulls the xs field back by its padding plus its border, and gives it back on the right", () => {
		render(<Input aria-label="f" size="xs" />);
		const list = classes(screen.getByLabelText("f"));
		const pad = list.find((c) => /^px-[\d.]+$/.test(c))?.slice(3);
		expect(pad, "xs lost its horizontal padding").toBeDefined();
		// The 1px border sits outside the padding, so the pull-back is
		// padding + border or the text lands 1px right of the label.
		const offset = `var(--spacing)*${pad}+1px`;
		expect(list).toContain(`-ml-[calc(${offset})]`);
		expect(list).toContain(`w-[calc(100%+${offset})]`);
		expect(list).toContain("border");
	});

	it("does not forward size to the DOM as the native numeric attribute", () => {
		render(<Input aria-label="f" size="xs" />);
		expect(screen.getByLabelText("f").hasAttribute("size")).toBe(false);
	});

	it("never trims or clips its text box, at any size", () => {
		// A `text-box` trim on a field with no vertical padding (xs is `py-0`)
		// cut every descender and underscore off at the field's own edge
		// (#1830): "Create charge" rendered as "Create charae", "base_url" as
		// "base url". The rename field lands on a `cap-centred` label's line
		// without one, so nothing here may trim, clamp or clip vertically.
		for (const size of [undefined, "sm", "xs"] as const) {
			const { unmount } = render(<Input aria-label="f" size={size} />);
			const list = classes(screen.getByLabelText("f"));
			expect(
				list.filter((c) => /text-box|cap-centred|overflow-|leading-none/.test(c))
			).toEqual([]);
			unmount();
		}
	});

	it("lets a caller class override the primitive's width", () => {
		render(<Input aria-label="f" size="sm" className="w-24" />);
		const list = classes(screen.getByLabelText("f"));
		expect(list).toContain("w-24");
		expect(list).not.toContain("w-full");
	});
});
