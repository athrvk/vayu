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
 * The collection screen's active sub-tab, kept per collection id in
 * `tab-selection-store`.
 *
 * `Shell.tsx` mounts one workspace-tab's surface at a time, so switching away
 * from a collection tab and back used to reset this screen to Info every
 * time - `tab` was a bare `useState` with no memory of which collection it
 * belonged to. It also has to survive the case that never unmounts at all:
 * two open collection tabs are the same `CollectionDetail` instance (the
 * component is not remounted when the user switches to a sibling
 * collection's tab - see the comment above `DataTab`'s `key` prop in
 * `index.tsx`), so a plain `useState` would carry collection A's tab
 * straight onto collection B.
 *
 * Mutation check: drop the `setCollectionTab` write from the wrapped `setTab`,
 * or drop the `getCollectionTab` read from either the mount initializer or
 * the `tabSyncedFor` sync in `index.tsx`, and the "survives" cases below fail
 * red; restoring either makes them green again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import CollectionDetail from "./index";

const collections = [
	{ id: "c1", name: "Collection One", variables: {} },
	{ id: "c2", name: "Collection Two", variables: {} },
];

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => ({ data: collections, isLoading: false, isError: false }),
	useRequestsQuery: () => ({ data: [], isLoading: false }),
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map(), isLoading: false }),
}));

/** Which collection's tab is "active" in the tab strip - mutated between renders. */
let activeCollectionId = "c1";

vi.mock("@/stores", () => ({
	useTabsStore: () => ({
		openTabs: [
			{ id: "t1", type: "collection", entityId: "c1" },
			{ id: "t2", type: "collection", entityId: "c2" },
		],
		activeTabId: activeCollectionId === "c1" ? "t1" : "t2",
	}),
	useSessionStore: (selector: (s: unknown) => unknown) =>
		selector({ setLastCollectionId: vi.fn() }),
}));

// Panel content is not what these tests are about - only which trigger the
// tab strip marks active - and several of these drag in Monaco or the engine.
vi.mock("./InfoTab", () => ({ default: () => null }));
vi.mock("./AuthTab", () => ({ default: () => null }));
vi.mock("./ElementsTab", () => ({ default: () => null }));
vi.mock("./VariablesTab", () => ({ default: () => null }));
vi.mock("./DataTab", () => ({ default: () => null }));
vi.mock("./SpecTab", () => ({ default: () => null }));
vi.mock("./MockServerControl", () => ({ default: () => null }));

function Screen() {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<CollectionDetail />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** Radix activates a trigger on `mousedown`, not on `click`. */
function selectTab(label: RegExp) {
	fireEvent.mouseDown(screen.getByRole("tab", { name: label }), { button: 0 });
}

function activeTabName(): string | null {
	const active = screen
		.getAllByRole("tab")
		.filter((t) => t.getAttribute("data-state") === "active");
	expect(active.length, "exactly one tab must be selected").toBe(1);
	return active[0]?.textContent?.trim() ?? null;
}

beforeEach(() => {
	useTabSelectionStore.getState().clearAll();
	activeCollectionId = "c1";
});

describe("the active collection tab, kept per collection id", () => {
	it("defaults to Info for a collection seen for the first time", () => {
		render(<Screen />);
		expect(activeTabName()).toMatch(/info/i);
	});

	it("survives Shell unmounting and remounting the screen for the same collection", () => {
		const { unmount } = render(<Screen />);
		selectTab(/auth/i);
		expect(activeTabName()).toMatch(/auth/i);

		unmount();

		// A different collection, mounted fresh - shows its own default, not c1's.
		activeCollectionId = "c2";
		const { unmount: unmountB } = render(<Screen />);
		expect(activeTabName()).toMatch(/info/i);
		unmountB();

		// Back to c1 - its own selection is still there.
		activeCollectionId = "c1";
		render(<Screen />);
		expect(activeTabName()).toMatch(/auth/i);
	});

	it("also keeps each collection's tab separate when moving between two open collection tabs without a remount", () => {
		// `CollectionDetail` is not remounted for a switch between two
		// collection tabs - `activeTabId` changes under the same component
		// instance, exactly what the render-time `tabSyncedFor` sync (not
		// just the mount initializer) has to answer for.
		const { rerender } = render(<Screen />);
		selectTab(/elements/i);
		expect(activeTabName()).toMatch(/elements/i);

		activeCollectionId = "c2";
		rerender(<Screen />);
		expect(activeTabName()).toMatch(/info/i);

		activeCollectionId = "c1";
		rerender(<Screen />);
		expect(activeTabName()).toMatch(/elements/i);
	});
});
