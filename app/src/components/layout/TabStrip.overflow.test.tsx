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

/** jsdom lays nothing out, so the strip's width has to be supplied. */
function stubStripWidth(px: number) {
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get() {
			return this.getAttribute("role") === "tablist" ? px : 0;
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
		 */
		expect(screen.getByRole("tablist").className).toMatch(/\bflex-1\b/);
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

	it("keeps the active tab on screen however narrow it gets", () => {
		// Selecting a tab from the overflow menu has to put it in the strip.
		useTabsStore.setState({ openTabs: [...TABS], activeTabId: "t7" });
		stubStripWidth(240);
		renderStrip();
		const ids = screen.getAllByRole("tab").map((el) => el.getAttribute("data-tab-id"));
		expect(ids).toContain("t7");
	});
});

describe("title bar drag region", () => {
	/*
	 * The empty space to the right of the last tab has to move the window. It
	 * stopped doing so when the strip gained `flex-1`: the root carried
	 * `app-region: no-drag`, which was harmless while the element sized to its
	 * content - the slack belonged to the draggable parent - and swallowed the
	 * whole bar once it spanned the full width.
	 *
	 * So the container must NOT opt out, and every interactive child must.
	 */
	const appRegion = (el: HTMLElement) =>
		(el.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion;

	it("leaves the strip itself draggable", () => {
		stubStripWidth(2000);
		renderStrip();
		expect(appRegion(screen.getByRole("tablist"))).toBeFalsy();
	});

	it("opts every tab out, so tabs stay clickable", () => {
		stubStripWidth(2000);
		renderStrip();
		for (const tab of screen.getAllByRole("tab")) {
			expect(appRegion(tab)).toBe("no-drag");
		}
	});

	it("opts the new-tab button out", () => {
		stubStripWidth(2000);
		renderStrip();
		expect(appRegion(screen.getByLabelText("New tab"))).toBe("no-drag");
	});

	it("opts the overflow control out", () => {
		stubStripWidth(320);
		renderStrip();
		const shown = screen.getAllByRole("tab").length;
		expect(appRegion(screen.getByLabelText(`${TABS.length - shown} more tabs`))).toBe(
			"no-drag"
		);
	});
});
