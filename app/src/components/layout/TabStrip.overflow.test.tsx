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
 * The strip must measure the space it has, not the space it is using.
 *
 * It sizes each tab to its name and overflows the rest, which means it reads
 * its own `clientWidth` to decide how many fit. That is only a question worth
 * asking if the element fills its parent. It did not: the root was a flex item
 * with no `flex-1`, so it sized to its content, and the measurement became a
 * loop - measure the tabs, trim to "the available space", the content shrinks,
 * trim again. It settled on one visible tab and "+7" on a full-width window.
 *
 * jsdom performs no layout, so it cannot reproduce that loop; `clientWidth` is
 * 0 for everything here. So this pins the two halves separately: the class that
 * makes the element fill its parent, and the fit behaviour with the width
 * stubbed. Neither alone would have caught it, and the first is the one that
 * regressed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TabStrip } from "./TabStrip";
import { useTabsStore } from "@/stores";

vi.mock("@/queries", () => ({
	requestDetailOptions: () => ({
		queryKey: ["request"],
		queryFn: async () => undefined,
		enabled: false,
	}),
	runDetailOptions: () => ({ queryKey: ["run"], queryFn: async () => undefined, enabled: false }),
	useCollectionsQuery: () => ({ data: [] }),
}));
vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString: (s: string) => s }),
}));

const TABS = Array.from({ length: 8 }, (_, i) => ({
	id: `t${i}`,
	type: "settings" as const,
	entityId: null,
}));

/**
 * The strip root: the element that measures, and the one carrying the row's
 * layout. The tablist is a child of it and holds only tabs - the overflow
 * trigger and the New-tab button are not tabs and must not be inside a
 * `role="tablist"`.
 */
function stripRoot(): HTMLElement {
	return screen.getByRole("tablist").parentElement as HTMLElement;
}

/** jsdom lays nothing out, so the strip's width has to be supplied. */
function stubStripWidth(px: number) {
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return this.querySelector(':scope > [role="tablist"]') ? px : 0;
		},
	});
}

function renderStrip() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TabStrip />
		</QueryClientProvider>
	);
}

beforeEach(() => {
	useTabsStore.setState({ openTabs: [...TABS], activeTabId: "t0" });
});
afterEach(() => {
	cleanup();
	// @ts-expect-error - restore jsdom's own getter
	delete HTMLElement.prototype.clientWidth;
});

describe("tab strip width", () => {
	it("fills its parent instead of sizing to its own tabs", () => {
		stubStripWidth(1200);
		renderStrip();
		/*
		 * Without this the element is as wide as its content, so the width it
		 * measures is the width it already chose - a loop that collapses the strip
		 * to a single tab no matter how wide the window is. There is no way to
		 * observe that in jsdom, so the class itself is the assertion.
		 *
		 * `w-full`, not `flex-1`: the strip is a column item now (tab row over
		 * main+context), where `flex-1` would grow it vertically and leave the
		 * width to its content - the same loop, reintroduced by a class that
		 * looks like the one that fixed it.
		 */
		expect(stripRoot().className).toMatch(/\bw-full\b/);
	});

	it("takes its height from the band token the drawer header shares", () => {
		stubStripWidth(1200);
		renderStrip();
		// A bare h-8 here would drift from the drawer's header the moment either
		// side changed, and the two are one band across the window: the strip's
		// left edge is the drawer's right edge.
		expect(stripRoot().className).toContain("h-[var(--tabstrip-height)]");
	});

	it("shows every tab when there is room", () => {
		stubStripWidth(2000);
		renderStrip();
		expect(screen.getAllByRole("tab")).toHaveLength(TABS.length);
		expect(screen.queryByLabelText(/more tabs/i)).not.toBeInTheDocument();
	});

	it("moves the surplus into the overflow menu when there is not", () => {
		stubStripWidth(320);
		renderStrip();
		const shown = screen.getAllByRole("tab").length;
		expect(shown).toBeGreaterThan(0);
		expect(shown).toBeLessThan(TABS.length);
		expect(screen.getByLabelText(`${TABS.length - shown} more tabs`)).toBeInTheDocument();
	});

	it("keeps the overflow trigger outside the tab set", () => {
		stubStripWidth(320);
		renderStrip();
		const shown = screen.getAllByRole("tab").length;
		const trigger = screen.getByLabelText(`${TABS.length - shown} more tabs`);
		// A `role="tablist"` owns only tabs, so inside it the "+N" menu is counted
		// and announced as one of them - "6 of 6" with a sixth that is a dropdown.
		expect(screen.getByRole("tablist").contains(trigger)).toBe(false);
		expect(stripRoot().contains(trigger)).toBe(true);
	});

	it("keeps the active tab on screen however narrow it gets", () => {
		// Selecting a tab from the overflow menu has to put it in the strip.
		useTabsStore.setState({ openTabs: [...TABS], activeTabId: "t7" });
		stubStripWidth(240);
		renderStrip();
		const ids = screen.getAllByRole("tab").map((el) => el.getAttribute("data-tab-id"));
		expect(ids).toContain("t7");
	});
});

describe("drag regions", () => {
	/*
	 * The strip used to live in the title bar, where the row was a drag region
	 * and every interactive child had to opt out of it - a tab that did not was
	 * simply unclickable, because a drag area ignores pointer events.
	 *
	 * It does not live there any more. Nothing in the content area drags the
	 * window, so an `app-region` marker down here guards against a rule that no
	 * longer reaches this subtree, and reads as though it still does. The
	 * title-row half of the invariant - the header drags, its controls do not -
	 * moved with the geometry to `TitleBar.search-bar.test.tsx`.
	 */
	const appRegion = (el: HTMLElement) =>
		(el.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion;

	it("declares no drag region on the strip or anything in it", () => {
		stubStripWidth(320);
		renderStrip();
		const shown = screen.getAllByRole("tab").length;
		// Non-empty by construction: the strip is stubbed narrow so it renders
		// tabs *and* the overflow control, and a scan of nothing passes anything.
		const marked = [
			stripRoot(),
			screen.getByRole("tablist"),
			...screen.getAllByRole("tab"),
			screen.getByLabelText("New tab"),
			screen.getByLabelText(`${TABS.length - shown} more tabs`),
		];
		expect(marked.length).toBeGreaterThan(3);
		for (const el of marked) expect(appRegion(el)).toBeFalsy();
	});
});
