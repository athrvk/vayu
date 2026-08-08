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
 * The bar's frame, and what it does with a section list.
 *
 * The frame cases each pin a defect the bar shipped with: a 14px close target,
 * an anonymous `<div>` where the facing Drawer is a labelled landmark, a doubled
 * 1px left edge, and a root that was simultaneously the scroll container and the
 * resize handle's positioning context - so scrolling carried the drag strip and
 * the header out of view.
 *
 * The registry is mocked to two stub sections on purpose. This file is about the
 * *frame*: which sections exist is `context-bar/registry.test.tsx`, and what each
 * one shows is its own test. Stubbing also makes the mount-gating assertion
 * exact - a section's component is a spy, so "a collapsed section runs no
 * queries" becomes "the component was never called", which is the mechanism
 * rather than a proxy for it.
 *
 * The structural cases assert `className`, not geometry: jsdom has no layout and
 * reports 0 for every measurement, so an `offsetHeight` or `scrollTop` guard
 * here would pass while measuring nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextBar } from "./ContextBar";
import { TooltipProvider } from "@/components/ui";
import { useLayoutStore, useTabsStore } from "@/stores";

const alphaBody = vi.fn(() => <input aria-label="Alpha input" defaultValue="alpha" />);
const betaBody = vi.fn(() => <p>beta body</p>);

vi.mock("./context-bar/registry", () => ({
	sectionsForTab: (tab: { type: string } | undefined) =>
		tab?.type === "request"
			? [
					{ id: "alpha", title: "Alpha", appliesTo: () => true, Component: alphaBody },
					{ id: "beta", title: "Beta", appliesTo: () => true, Component: betaBody },
				]
			: [],
}));

function renderBar(mode?: "push" | "overlay") {
	return render(
		<TooltipProvider>
			<ContextBar mode={mode} />
		</TooltipProvider>
	);
}

/** The bar's root - the landmark, and the element the mode classes land on. */
function bar(): HTMLElement {
	return screen.getByRole("complementary", { name: "Context sidebar" });
}

function sectionToggle(title: string): HTMLElement {
	return screen.getByRole("button", { name: title });
}

beforeEach(() => {
	alphaBody.mockClear();
	betaBody.mockClear();
	useLayoutStore.setState({
		contextBarOpen: true,
		contextBarWidth: 280,
		contextBarCollapsedSections: [],
	});
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1" }],
		activeTabId: "t1",
	});
});

describe("ContextBar - the sections it is given", () => {
	it("renders one collapsible per section, in registry order", () => {
		renderBar();
		const titles = screen.getAllByRole("button").map((b) => b.textContent);
		expect(titles).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
		expect(titles.indexOf("Alpha")).toBeLessThan(titles.indexOf("Beta"));
		expect(screen.getByText("beta body")).toBeInTheDocument();
	});

	it("renders nothing at all on a tab type with no sections", () => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "settings", entityId: null }],
			activeTabId: "t1",
		});
		const { container } = renderBar();
		// Not an empty frame: the toggle's pressed state reads the same predicate,
		// so a bar that rendered a chrome-only shell here would light the button
		// over nothing.
		expect(container).toBeEmptyDOMElement();
	});

	it("renders nothing when the bar is closed", () => {
		useLayoutStore.setState({ contextBarOpen: false });
		const { container } = renderBar();
		expect(container).toBeEmptyDOMElement();
	});

	it("does not mount a collapsed section's component", () => {
		useLayoutStore.setState({ contextBarCollapsedSections: ["beta"] });
		renderBar();

		// The whole cost model of the bar: it is open on every request tab, so a
		// section the user collapsed must not be running its queries. Mounting the
		// component is what registers them, so not mounting it is the guarantee.
		expect(alphaBody).toHaveBeenCalled();
		expect(betaBody).not.toHaveBeenCalled();
		expect(screen.queryByText("beta body")).not.toBeInTheDocument();
		// The header is still there - a collapsed section is collapsed, not gone.
		expect(sectionToggle("Beta")).toBeInTheDocument();
	});

	it("collapsing a section persists it, and expanding removes it", () => {
		renderBar();

		fireEvent.click(sectionToggle("Alpha"));
		expect(useLayoutStore.getState().contextBarCollapsedSections).toEqual(["alpha"]);

		fireEvent.click(sectionToggle("Alpha"));
		expect(useLayoutStore.getState().contextBarCollapsedSections).toEqual([]);
	});

	it("states each section's expanded state for a screen reader", () => {
		useLayoutStore.setState({ contextBarCollapsedSections: ["beta"] });
		renderBar();
		expect(sectionToggle("Alpha")).toHaveAttribute("aria-expanded", "true");
		expect(sectionToggle("Beta")).toHaveAttribute("aria-expanded", "false");
	});
});

describe("ContextBar - naming what a screen reader reads", () => {
	it("is a labelled landmark, like the Drawer facing it", () => {
		renderBar();
		// An anonymous <div> could not be jumped to; the left panel could.
		// `getByRole("complementary", { name })` is the assertion - it resolves
		// only if both the landmark and its label are there.
		expect(bar().tagName).toBe("ASIDE");
	});

	it("gives the close button the documented icon-button box", () => {
		renderBar();
		const close = screen.getByRole("button", { name: "Close context bar" });
		// The hit area used to be the 14px icon itself - the smallest target in
		// the shell.
		expect(close.className).toContain("h-6");
		expect(close.className).toContain("w-6");
	});
});

describe("ContextBar - the frame stays put while the list scrolls", () => {
	it("puts the overflow on an inner wrapper, not on the root", () => {
		renderBar();

		const root = bar();
		// With the overflow on the root, the root was both the scroll container
		// and the handle's positioning context: scrolling carried the drag strip,
		// the header and the close button away and left the lower edge
		// un-draggable.
		expect(root.className).not.toContain("overflow-y-auto");

		const scroller = root.querySelector(".overflow-y-auto");
		expect(scroller).not.toBeNull();
		// The two things that must survive a scroll are outside it.
		expect(scroller!.contains(screen.getByRole("separator"))).toBe(false);
		expect(scroller!.contains(screen.getByRole("button", { name: "Close context bar" }))).toBe(
			false
		);
		// …and the sections are inside it.
		expect(scroller!.contains(screen.getByRole("textbox", { name: "Alpha input" }))).toBe(true);
	});

	it("paints one left edge, not two", () => {
		renderBar();
		// The root's `border-l` sat on top of the handle's own 1px hairline; the
		// Drawer's identical handle-drawn edge is 1px.
		expect(bar().className).not.toContain("border-l");
	});
});

describe("ContextBar - push and overlay modes", () => {
	it("floats over the content in overlay mode", () => {
		renderBar("overlay");
		const className = bar().className;
		expect(className).toContain("absolute");
		expect(className).toContain("shadow-lg");
	});

	it("takes layout space in push mode", () => {
		renderBar("push");
		const className = bar().className;
		expect(className).toContain("relative");
		expect(className).not.toContain("absolute");
		expect(className).not.toContain("shadow-lg");
	});
});
