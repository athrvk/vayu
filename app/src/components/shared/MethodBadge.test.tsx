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
 * The badge variant is a fixed-width column: sibling rows put the badge first
 * and the request name after it, so a chip that grew with its letters started
 * `GET` names at one x and `DELETE` names at another.
 *
 * jsdom does no layout - `offsetWidth` is 0 for everything - so "the two chips
 * are the same width" cannot be measured here. These tests pin the *class
 * contract* that produces it instead, and render the component rather than
 * scanning the source, because the class arrives through `cn()` (a source scan
 * would keep passing after the class was removed from the branch).
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MethodBadge } from "./MethodBadge";

/** The chip element itself - the outer span `MethodBadge` renders. */
function renderBadge(ui: React.ReactElement): HTMLElement {
	const { container } = render(ui);
	return container.firstElementChild as HTMLElement;
}

/**
 * The width class the badge variant must carry: seven characters of content
 * (OPTIONS, CONNECT) plus the chip's own `px-1.5` and 1px border.
 */
const WIDTH_CLASS = "w-[calc(7ch+0.75rem+2px)]";

describe("MethodBadge - badge variant is a fixed-width column", () => {
	it("carries the fixed width, so the label after it starts at a fixed x", () => {
		const badge = renderBadge(<MethodBadge method="GET" />);
		expect(badge.className).toContain(WIDTH_CLASS);
	});

	it("renders GET and DELETE with an identical box", () => {
		// Method colour is an inline style, so the class list is the whole box:
		// identical classes including the fixed width means identical width.
		const get = renderBadge(<MethodBadge method="GET" />);
		const del = renderBadge(<MethodBadge method="DELETE" />);
		expect(get.className).toBe(del.className);
		expect(get.className).toContain(WIDTH_CLASS);
	});

	it("uses the same width class at both sizes", () => {
		// The width is in `ch`, so it tracks the chip's own font size rather than
		// needing a second value per size.
		const sm = renderBadge(<MethodBadge method="GET" size="sm" />);
		const md = renderBadge(<MethodBadge method="GET" size="md" />);
		expect(sm.className).toContain(WIDTH_CLASS);
		expect(md.className).toContain(WIDTH_CLASS);
	});

	it("centres the label on both axes", () => {
		const badge = renderBadge(<MethodBadge method="GET" />);
		expect(badge.className).toContain("inline-flex");
		expect(badge.className).toContain("items-center");
		expect(badge.className).toContain("justify-center");
	});
});

describe("MethodBadge - methods longer than the column", () => {
	it("truncates a long custom method instead of widening the chip", () => {
		const badge = renderBadge(<MethodBadge method="PROPPATCH" />);
		expect(badge.className).toContain(WIDTH_CLASS);
		const label = badge.firstElementChild as HTMLElement;
		expect(label.textContent).toBe("PROPPATCH");
		expect(label.className).toContain("truncate");
		// Without `min-w-0` a flex item refuses to shrink below its content, so the
		// chip would widen and `truncate` would never fire.
		expect(label.className).toContain("min-w-0");
	});

	it("exposes the full method as a title only when it is truncated", () => {
		// An unconditional title would fight the app's own tooltips on the same
		// rows, so the absent case is as much of the contract as the present one.
		expect(renderBadge(<MethodBadge method="PROPPATCH" />).title).toBe("PROPPATCH");
		expect(renderBadge(<MethodBadge method="OPTIONS" />).title).toBe("");
		expect(renderBadge(<MethodBadge method="GET" />).title).toBe("");
	});
});

describe("MethodBadge - the text variant is unchanged", () => {
	it("takes no fixed width, so it stays inline in running text", () => {
		const badge = renderBadge(<MethodBadge method="GET" variant="text" />);
		expect(badge.className).not.toContain(WIDTH_CLASS);
		expect(badge.className).not.toContain("inline-flex");
		expect(badge.textContent).toBe("GET");
	});

	it("still lets a caller set its own width", () => {
		// The import preview aligns its own column this way; the badge variant no
		// longer needs the hack, this one still does.
		const badge = renderBadge(<MethodBadge method="GET" variant="text" className="w-10" />);
		expect(badge.className).toContain("w-10");
	});
});

describe("MethodBadge - existing behaviour", () => {
	it("upper-cases the method and keeps the muted dimming", () => {
		const badge = renderBadge(<MethodBadge method="post" muted />);
		expect(badge.textContent).toBe("POST");
		expect(badge.className).toContain("opacity-60");
	});
});
