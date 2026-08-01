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
 * The collection tabs hold their drafts in component state, and two things used
 * to take those drafts away without a word.
 *
 * **A tab switch.** Radix unmounts an inactive `TabsContent`, so renaming the
 * collection, glancing at Auth and coming back showed the old name again - the
 * same defect the request builder's body drafts hit, and fixed the same way, by
 * keeping the panel alive rather than by moving where the draft is stored.
 *
 * **Quit, or Ctrl/Cmd+S from anywhere.** None of the three tabs called
 * `registerContext`, so `flushAll` and `triggerSave` could not see them at all:
 * the save store's registry was the only list of dirty editors, and these were
 * absent from it.
 *
 * Both are asserted against the real save store, since a mocked registry would
 * pass whatever it was told.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CollectionDetail from "./index";
import { useSaveStore } from "@/stores/save-store";
import { TooltipProvider } from "@/components/ui";
import type { Collection } from "@/types";

const collection: Collection = {
	id: "c1",
	name: "Acme API",
	description: "",
	order: 0,
	variables: {},
	auth: { mode: "none" },
	preRequestScript: "",
	postRequestScript: "",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

const mutateAsync = vi.fn((_patch: { id: string; name?: string }) => Promise.resolve(collection));
const mutation = {
	mutate: vi.fn(),
	mutateAsync,
	reset: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => ({ data: [collection], isLoading: false, isError: false }),
	useRequestsQuery: () => ({ data: [], isLoading: false }),
	useUpdateCollectionMutation: () => mutation,
	useCollectionAncestors: () => [],
}));

vi.mock("@/stores", () => ({
	useTabsStore: () => ({
		openTabs: [{ id: "t1", type: "collection", entityId: "c1" }],
		activeTabId: "t1",
	}),
	useSessionStore: (selector: (s: unknown) => unknown) =>
		selector({ setLastCollectionId: vi.fn() }),
}));

// Monaco and the variables editor are not what these tests are about, and both
// drag in a great deal of setup.
vi.mock("./ScriptTab", () => ({ default: () => null }));
vi.mock("./VariablesTab", () => ({ default: () => null }));

function Screen() {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<CollectionDetail />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

function nameInput(): HTMLInputElement {
	return screen.getByDisplayValue("Acme API") as HTMLInputElement;
}

/**
 * Radix activates a trigger on `mousedown`, not on `click` - `fireEvent.click`
 * fires neither the mousedown nor the focus it listens for, so a click-driven
 * version of the test below never left the Info tab and passed against the
 * unfixed component.
 */
function selectTab(label: RegExp) {
	fireEvent.mouseDown(screen.getByRole("tab", { name: label }), { button: 0 });
	expect(screen.getByRole("tab", { name: label })).toHaveAttribute("data-state", "active");
}

describe("CollectionDetail - an unsaved draft", () => {
	beforeEach(() => {
		mutateAsync.mockClear();
		useSaveStore.setState({ contexts: new Map(), activeContextId: null, status: "idle" });
	});

	it("survives a switch to another tab and back", () => {
		render(<Screen />);
		fireEvent.change(nameInput(), { target: { value: "Renamed" } });

		selectTab(/auth/i);
		selectTab(/info/i);

		expect((screen.getByDisplayValue("Renamed") as HTMLInputElement).value).toBe("Renamed");
	});

	it("is visible to the quit flush, which writes it", async () => {
		render(<Screen />);
		fireEvent.change(nameInput(), { target: { value: "Renamed" } });

		await act(async () => {
			await useSaveStore.getState().flushAll();
		});

		expect(mutateAsync).toHaveBeenCalledTimes(1);
		expect(mutateAsync.mock.calls[0][0]).toMatchObject({ id: "c1", name: "Renamed" });
	});

	it("is what Ctrl/Cmd+S saves while its tab is the one on screen", async () => {
		render(<Screen />);
		fireEvent.change(nameInput(), { target: { value: "Renamed" } });

		// `triggerSave` prefers the active context, so the wrong tab claiming it
		// would save the wrong thing - hence the `active` prop.
		expect(useSaveStore.getState().activeContextId).toBe("collection-c1-info");

		await act(async () => {
			await useSaveStore.getState().triggerSave();
		});

		expect(mutateAsync).toHaveBeenCalledTimes(1);
	});

	it("registers nothing pending while it is clean", () => {
		render(<Screen />);

		const dirty = [...useSaveStore.getState().contexts.values()].filter(
			(c) => c.hasPendingChanges
		);
		expect(dirty).toHaveLength(0);
	});

	it("does not offer a blank collection name to the flush", async () => {
		// The Save button is disabled on an empty name; the store-driven paths
		// have no button to disable, so the guard has to be in the save itself.
		render(<Screen />);
		fireEvent.change(nameInput(), { target: { value: "" } });

		await act(async () => {
			await useSaveStore.getState().flushAll();
		});

		expect(mutateAsync).not.toHaveBeenCalled();
	});
});
