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
 * The drop line is one primitive on two axes. The rendered class list is the
 * contract (jsdom has no layout), and `RowDropIndicator` must stay the
 * horizontal case of it rather than drift into a copy.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RowDropIndicator } from "@/modules/collections/TreeRowDnd";
import { DropIndicator } from "./DropIndicator";

function indicator(container: HTMLElement): HTMLElement {
	const el = container.querySelector<HTMLElement>("[data-drop-indicator]");
	if (!el) throw new Error("no drop indicator rendered");
	return el;
}

describe("DropIndicator", () => {
	it("draws a horizontal line across the host, indented from the left", () => {
		const { container } = render(
			<DropIndicator edge="before" orientation="horizontal" indentPx={24} />
		);
		const el = indicator(container);
		expect(el.getAttribute("data-drop-indicator")).toBe("before");
		expect(el.getAttribute("aria-hidden")).toBe("true");
		expect(el.className).toContain("pointer-events-none");
		expect(el.className).toContain("h-0.5");
		expect(el.className).toContain("top-0");
		expect(el.className).not.toContain("w-0.5");
		expect(el.style.left).toBe("24px");
	});

	it("sits on the bottom edge for an after drop", () => {
		const { container } = render(
			<DropIndicator edge="after" orientation="horizontal" indentPx={0} />
		);
		const el = indicator(container);
		expect(el.getAttribute("data-drop-indicator")).toBe("after");
		expect(el.className).toContain("bottom-0");
		expect(el.className).not.toContain("top-0");
	});

	it("draws a vertical line down the host's full height", () => {
		const { container } = render(<DropIndicator edge="before" orientation="vertical" />);
		const el = indicator(container);
		expect(el.getAttribute("data-drop-indicator")).toBe("before");
		expect(el.getAttribute("aria-hidden")).toBe("true");
		expect(el.className).toContain("pointer-events-none");
		expect(el.className).toContain("w-0.5");
		expect(el.className).toContain("inset-y-0");
		expect(el.className).toContain("left-0");
		expect(el.className).not.toContain("h-0.5");
		expect(el.style.left).toBe("");
	});

	it("sits on the right edge for an after drop", () => {
		const { container } = render(<DropIndicator edge="after" orientation="vertical" />);
		const el = indicator(container);
		expect(el.className).toContain("right-0");
		expect(el.className).not.toContain("left-0");
	});
});

describe("RowDropIndicator", () => {
	it("renders the horizontal line at the row's indent", () => {
		const { container } = render(<RowDropIndicator edge="after" indentPx={16} />);
		const el = indicator(container);
		expect(el.className).toContain("h-0.5");
		expect(el.className).toContain("bottom-0");
		expect(el.className).not.toContain("inset-y-0");
		expect(el.style.left).toBe("16px");
	});

	it("renders nothing without an edge", () => {
		const { container } = render(<RowDropIndicator edge={null} indentPx={16} />);
		expect(container.querySelector("[data-drop-indicator]")).toBeNull();
	});
});
