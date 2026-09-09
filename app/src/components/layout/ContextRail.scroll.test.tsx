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
 * `ContextRail` scrolling `ContextBar`'s own scroller (#1615, #1612).
 *
 * `ContextRail.test.tsx` covers the click branches (open, expand, collapse) in
 * isolation, against `useLayoutStore` state alone - it never renders `ContextBar`,
 * so it cannot see whether `scrollWithin` is actually called, or called against
 * the right elements. This file renders both together, with a stub registry (the
 * same `sectionsForTab` mock `ContextBar.markup.test.tsx` uses) so the assertion
 * is about the wiring between the two components, not about any one section's
 * content.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { Braces, KeyRound } from "lucide-react";
import { TooltipProvider } from "@/components/ui";
import { useLayoutStore, useTabsStore } from "@/stores";
import { ContextBar } from "./ContextBar";
import { ContextRail } from "./ContextRail";
import { scrollWithin } from "@/lib/scroll-within";

vi.mock("@/lib/scroll-within", () => ({ scrollWithin: vi.fn() }));

vi.mock("./context-bar/registry", () => ({
	sectionsForTab: (tab: { type: string } | undefined) =>
		tab?.type === "request"
			? [
					{
						id: "alpha",
						title: "Alpha",
						icon: Braces,
						appliesTo: () => true,
						Component: () => <p>alpha body</p>,
					},
					{
						id: "beta",
						title: "Beta",
						icon: KeyRound,
						appliesTo: () => true,
						Component: () => <p>beta body</p>,
					},
				]
			: [],
}));

/**
 * `requestAnimationFrame` runs the scroll a frame after the click, so the DOM
 * has caught up with the open/expand state the same handler just requested
 * (`ContextRail.tsx`'s own comment on this). Stubbed onto a macrotask rather
 * than called back synchronously: React batches the `set` calls earlier in
 * the same handler and only flushes them once the handler returns, so a
 * synchronous stub would fire *before* that flush, querying a DOM that has
 * not opened yet - the section wrapper does not exist at all while
 * `contextBarOpen` is still `false`. A real browser's rAF always waits for
 * the next paint, which is after React's flush; `setTimeout` reproduces that
 * ordering, and the tests below `await` it the same way they would await a
 * real frame.
 */
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
	return setTimeout(() => cb(0), 0) as unknown as number;
});

function renderBoth() {
	return render(
		<TooltipProvider>
			<ContextBar />
			<ContextRail />
		</TooltipProvider>
	);
}

/**
 * The rail's own button, not the bar's collapsible trigger - both are named
 * "Alpha" (`ContextBar`'s section header renders the same title, plain text
 * rather than an icon), so `getByRole` alone is ambiguous the moment both are
 * rendered together.
 */
function railButton(name: string): HTMLElement {
	return within(screen.getByRole("navigation", { name: "Context sections" })).getByRole(
		"button",
		{
			name,
		}
	);
}

beforeEach(() => {
	vi.mocked(scrollWithin).mockClear();
	useLayoutStore.setState({
		contextBarOpen: false,
		contextBarWidth: 280,
		contextBarCollapsedSections: ["alpha", "beta"],
	});
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1" }],
		activeTabId: "t1",
	});
});

describe("ContextRail scrolls the section it opens", () => {
	it("scrolls the bar's own scroller to the section, not the window", async () => {
		renderBoth();
		fireEvent.click(railButton("Alpha"));

		await waitFor(() => expect(scrollWithin).toHaveBeenCalledTimes(1));
		const [container, target, opts] = vi.mocked(scrollWithin).mock.calls[0];
		expect(container).toHaveAttribute("data-context-bar-scroller");
		expect(target).toHaveAttribute("data-context-bar-section", "alpha");
		expect(opts).toEqual({ block: "nearest" });
	});

	it("scrolls again for a section that is already expanded, but not alone", async () => {
		useLayoutStore.setState({ contextBarOpen: true, contextBarCollapsedSections: [] });
		renderBoth();
		fireEvent.click(railButton("Alpha"));

		await waitFor(() => expect(scrollWithin).toHaveBeenCalledTimes(1));
	});

	it("does not scroll when the click collapses the whole bar instead", async () => {
		useLayoutStore.setState({ contextBarOpen: true, contextBarCollapsedSections: ["beta"] });
		renderBoth();
		fireEvent.click(railButton("Alpha"));

		expect(useLayoutStore.getState().contextBarOpen).toBe(false);
		// The rAF macrotask still needs a turn to prove silence rather than
		// asserting on a callback that has not had the chance to run yet.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(scrollWithin).not.toHaveBeenCalled();
	});
});
