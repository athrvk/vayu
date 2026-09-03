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
 * The title row's Back and Forward buttons (#1245).
 *
 * Three things a rendered test can hold and a source scan cannot: that they are
 * named (an icon-only control with no name is a control a screen reader cannot
 * offer), that they leave the drag region (a `-webkit-app-region: drag` area
 * ignores pointer events, so a control that forgets to opt out is dead), and
 * that each is disabled exactly while its half of the history is empty.
 *
 * The platform flags in `TitleBar` are module-level constants read at import
 * time, so the platform is stubbed before the import - the shape
 * `TitleBar.search-bar.test.tsx` uses, and the store is re-imported with it for
 * the reason stated there.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useEnvironmentsQuery: () => ({ data: [] }),
}));

const appRegion = (el: HTMLElement) =>
	(el.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion;

/** What the compositor would use: the element's own declaration or an ancestor's. */
function effectiveRegion(el: HTMLElement | null): string | undefined {
	for (let node = el; node; node = node.parentElement) {
		const region = appRegion(node);
		if (region) return region;
	}
	return undefined;
}

interface Visited {
	/** Places visited, oldest first. */
	history: { type: "request"; entityId: string }[];
	/** Where in them the user is. */
	index: number;
	/** Which of them have a tab open, by entity id. */
	open?: string[];
}

async function renderWith({ history, index, open = [] }: Visited) {
	Object.defineProperty(window, "electronAPI", {
		value: {
			platform: "linux",
			windowIsMaximized: () => Promise.resolve(false),
			onWindowMaximized: () => () => {},
			windowMinimize: () => {},
			windowMaximize: () => {},
			windowClose: () => {},
		},
		writable: true,
		configurable: true,
	});
	vi.resetModules();
	// The provider comes from the same fresh graph as the bar: after
	// `resetModules` a statically imported one is a different Radix instance,
	// and the tooltip context would not match.
	const [{ default: TitleBar }, { useTabsStore }, { TooltipProvider }] = await Promise.all([
		import("./TitleBar"),
		import("@/stores"),
		import("@/components/ui"),
	]);
	useTabsStore.setState({
		openTabs: open.map((entityId, i) => ({ id: `tab-${i}`, type: "request", entityId })),
		activeTabId: open.length > 0 ? `tab-${open.length - 1}` : null,
		tabFocusedAt: {},
		navHistory: history,
		navIndex: index,
	});
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return {
		...render(
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<TitleBar />
				</TooltipProvider>
			</QueryClientProvider>
		),
		useTabsStore,
	};
}

const back = () => screen.getByRole("button", { name: "Back" });
const forward = () => screen.getByRole("button", { name: "Forward" });

const TWO_PLACES: Visited["history"] = [
	{ type: "request", entityId: "req-1" },
	{ type: "request", entityId: "req-2" },
];

beforeEach(cleanup);
afterEach(() => vi.resetModules());

describe("the title row's navigation buttons", () => {
	it("names both buttons, so they are more than two arrows", async () => {
		await renderWith({ history: TWO_PLACES, index: 1, open: ["req-1", "req-2"] });
		expect(back()).toBeInTheDocument();
		expect(forward()).toBeInTheDocument();
	});

	it("leaves the drag region, or the click would never land", async () => {
		await renderWith({ history: TWO_PLACES, index: 1, open: ["req-1", "req-2"] });
		expect(effectiveRegion(back())).toBe("no-drag");
		expect(effectiveRegion(forward())).toBe("no-drag");
	});

	it("disables both where the user has not been anywhere", async () => {
		await renderWith({ history: [], index: -1 });
		expect(back()).toBeDisabled();
		expect(forward()).toBeDisabled();
	});

	it("offers Back once there is somewhere behind, and Forward only after it", async () => {
		const { useTabsStore } = await renderWith({
			history: TWO_PLACES,
			index: 1,
			open: ["req-1", "req-2"],
		});
		expect(back()).toBeEnabled();
		expect(forward()).toBeDisabled();

		fireEvent.click(back());

		expect(useTabsStore.getState().navIndex).toBe(0);
		expect(back()).toBeDisabled();
		expect(forward()).toBeEnabled();
	});

	it("shows the request the step lands on", async () => {
		const { useTabsStore } = await renderWith({
			history: TWO_PLACES,
			index: 1,
			open: ["req-1", "req-2"],
		});

		fireEvent.click(back());

		const { openTabs, activeTabId } = useTabsStore.getState();
		expect(openTabs.find((t) => t.id === activeTabId)?.entityId).toBe("req-1");
	});
});
