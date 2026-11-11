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
 * Three things used to take a collection tab's unsaved draft away without a
 * word.
 *
 * **A sub-tab switch.** Radix unmounts an inactive `TabsContent`, so renaming
 * the collection, glancing at Auth and coming back showed the old name again.
 * Fixed by keeping a visited panel mounted.
 *
 * **Quit, or Ctrl/Cmd+S from anywhere.** None of the three tabs called
 * `registerContext`, so `flushAll` and `triggerSave` could not see them at all:
 * the save store's registry was the only list of dirty editors, and these were
 * absent from it.
 *
 * **A look at another workspace tab (#3459).** `Shell.tsx` mounts only the tab
 * on screen, so clicking a request unmounted this whole screen and the draft
 * with it - no prompt, the Dock idle, the old script still sent. The draft is
 * kept in `entity-draft-store` now, and its save context outlives the screen.
 *
 * All are asserted against the real save store, since a mocked registry would
 * pass whatever it was told.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CollectionDetail from "./index";
import { resetEntityDraftStoreForTests, useEntityDraftStore } from "@/stores/entity-draft-store";
import { resetSaveStoreForTests, useSaveStore } from "@/stores/save-store";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import { useTabsStore as useRealTabsStore } from "@/stores/tabs-store";
import { TooltipProvider } from "@/components/ui";
import type { Collection, ElementDef, ElementKindSchema } from "@/types";

const script: ElementDef = {
	id: "e1",
	kind: "script.pre",
	enabled: true,
	config: { script: "console.log(1);" },
};

const collection: Collection = {
	id: "c1",
	name: "Acme API",
	description: "",
	order: 0,
	variables: {},
	auth: { mode: "none" },
	elements: [script],
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

const mutateAsync = vi.fn((_patch: { id: string; name?: string; elements?: ElementDef[] }) =>
	Promise.resolve(collection)
);
// What the engine holds: a save that lands updates it, the way the real
// mutation's `onSuccess` updates the collections cache.
let stored: Collection = collection;

const mutation = {
	mutate: vi.fn(),
	mutateAsync,
	reset: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => ({ data: [stored], isLoading: false, isError: false }),
	useRequestsQuery: () => ({ data: [], isLoading: false }),
	// The shell counts the whole subtree for its header (issue #723); an empty
	// map is "no requests anywhere", which is what these cases are about.
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map(), isLoading: false }),
	useUpdateCollectionMutation: () => mutation,
	useCollectionAncestors: () => [],
}));

// The screen reads which tab is showing from a stub; the cases that close a tab
// drive the real store, imported directly.
vi.mock("@/stores", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/stores")>()),
	useTabsStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({
			openTabs: [{ id: "t1", type: "collection", entityId: "c1" }],
			activeTabId: "t1",
		}),
	useSessionStore: (selector: (s: unknown) => unknown) =>
		selector({ setLastCollectionId: vi.fn() }),
}));

// Monaco and the variables editor are not what these tests are about, and both
// drag in a great deal of setup.
vi.mock("./VariablesTab", () => ({ default: () => null }));
vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: () => null,
}));

// The Elements tab's kind list and its "Names mentioned" row; the wiring under
// test is the draft's, not theirs.
const SCRIPT_KIND: ElementKindSchema = {
	kind: "script.pre",
	version: 1,
	label: "Pre-request script",
	description: "",
	category: "script",
	hotPathClass: "script",
	collectionOnly: false,
	configSchema: { type: "object", properties: {} },
	phases: [],
};
vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useElementKindsQuery: () => ({ data: [SCRIPT_KIND] }),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));
vi.mock("@/hooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks")>()),
	useDataContract: () => undefined,
	useVariableResolver: () => ({
		resolveField: (value: string) => value,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
}));
// The header's mock-server control reaches the engine and the toast store;
// this file is about the tab shell, and its own suite covers the control.
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
		resetEntityDraftStoreForTests();
		resetSaveStoreForTests();
		useTabSelectionStore.getState().clearAll();
		stored = collection;
		mutateAsync.mockClear();
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

describe("CollectionDetail - an unsaved draft outliving the screen (#3459)", () => {
	beforeEach(() => {
		resetEntityDraftStoreForTests();
		resetSaveStoreForTests();
		useTabSelectionStore.getState().clearAll();
		stored = collection;
		mutateAsync.mockReset();
		mutateAsync.mockImplementation((patch) => {
			stored = { ...stored, ...patch };
			return Promise.resolve(stored);
		});
	});

	const toggle = () => screen.getByRole("switch", { name: /enable pre-request script/i });

	/** Elements tab open, its one script element disabled but not saved. */
	function editElements() {
		const view = render(<Screen />);
		selectTab(/elements/i);
		fireEvent.click(toggle());
		expect(toggle()).not.toBeChecked();
		return view;
	}

	it("is still there when the screen comes back, and Save elements writes it", () => {
		// Mutation check: drop the store and keep the draft in component state,
		// and the remount shows the script enabled again with Save disabled.
		editElements().unmount();

		render(<Screen />);

		expect(screen.getByRole("tab", { name: /elements/i })).toHaveAttribute(
			"data-state",
			"active"
		);
		expect(toggle()).not.toBeChecked();
		fireEvent.click(screen.getByRole("button", { name: /save elements/i }));
		expect(mutateAsync).toHaveBeenCalledWith({
			id: "c1",
			elements: [{ ...script, enabled: false }],
		});
	});

	it("keeps the tab dirty and the Dock on unsaved while the screen is gone", () => {
		// Mutation check: restore the unmount `discard(id)` in
		// `useDraftSaveContext` and the context is gone, the Dock idle, and
		// "Close saved tabs" takes the tab - and the draft - with it.
		editElements().unmount();

		const context = useSaveStore.getState().contexts.get("collection-c1-elements");
		expect(context?.hasPendingChanges).toBe(true);
		expect(useSaveStore.getState().status).toBe("pending");

		useRealTabsStore.setState({
			openTabs: [{ id: "t1", type: "collection", entityId: "c1" }],
			activeTabId: null,
		});
		useRealTabsStore.getState().closeSavedTabs();
		expect(useRealTabsStore.getState().openTabs.map((t) => t.id)).toEqual(["t1"]);
	});

	it("is saved by the quit flush with the screen gone, which then reads clean", async () => {
		// Mutation check: register no save after the unmount and the flush
		// writes nothing - `{ saved: 0 }` and the quit does not ask.
		editElements().unmount();

		const tally = await act(() => useSaveStore.getState().flushAll());

		expect(tally).toEqual({ saved: 1, failed: 0, pending: 0 });
		expect(mutateAsync).toHaveBeenCalledWith({
			id: "c1",
			elements: [{ ...script, enabled: false }],
		});
		expect(useSaveStore.getState().contexts.has("collection-c1-elements")).toBe(false);
		expect(useEntityDraftStore.getState().entries.size).toBe(0);
		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("makes the quit ask when that save fails, and keeps the draft", async () => {
		editElements().unmount();
		mutateAsync.mockRejectedValue(new Error("engine down"));

		const tally = await act(() => useSaveStore.getState().flushAll());

		// `failed > 0` is what `flushNeedsConfirmation` asks on.
		expect(tally).toEqual({ saved: 0, failed: 1, pending: 0 });
		expect(
			useSaveStore.getState().contexts.get("collection-c1-elements")?.hasPendingChanges
		).toBe(true);

		render(<Screen />);
		expect(toggle()).not.toBeChecked();
	});

	it("is the remounted editor's again, so a Reset there leaves its context alone", () => {
		// Mutation check: skip ending the detachment when the editor registers
		// again, and the Reset's drop reads to the old watch as the tab closing:
		// it unregisters the editor that is on screen.
		editElements().unmount();
		render(<Screen />);

		fireEvent.click(screen.getByRole("button", { name: /^reset$/i }));

		expect(toggle()).toBeChecked();
		expect(useSaveStore.getState().contexts.get("collection-c1-elements")).toMatchObject({
			hasPendingChanges: false,
		});
		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("lets the context go when a save started on screen lands after the screen went", async () => {
		// Save elements, then a click elsewhere before the write returns: no
		// editor is left to see the stored value catch up. Mutation check: drop
		// `markSaved` from the tab's save and the Dock keeps "Unsaved changes"
		// for an edit that is on disk.
		let land: () => void = () => {};
		mutateAsync.mockImplementationOnce(
			(patch) =>
				new Promise((resolve) => {
					land = () => {
						stored = { ...stored, ...patch };
						resolve(stored);
					};
				})
		);
		const view = editElements();
		fireEvent.click(screen.getByRole("button", { name: /save elements/i }));
		view.unmount();
		expect(useSaveStore.getState().contexts.has("collection-c1-elements")).toBe(true);

		await act(async () => land());

		expect(useSaveStore.getState().contexts.has("collection-c1-elements")).toBe(false);
		expect(useEntityDraftStore.getState().entries.size).toBe(0);
		expect(useSaveStore.getState().status).toBe("idle");
	});
});
