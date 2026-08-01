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
 * Typing while a save is in flight used to lose the keystrokes twice over.
 *
 * The sequence is one mutation round trip wide, and wider on a slow engine:
 * blur row A, so its save snapshots the rows and leaves; type in row B; the
 * save lands. Its `onSuccess` writes the query cache, the new `variables` prop
 * comes back into the editor, and the row-init effect rebuilt every row from
 * it - server state that predates B, so **B was reverted on screen**. The same
 * `onSuccess` also cleared the dirty flag, so B was marked saved as well and
 * nothing would ever write it: blur skips a clean editor, and so do Ctrl/Cmd+S
 * and the quit flush.
 *
 * Both halves are asserted here, because either one alone still loses data:
 * surviving on screen but reported clean is a row that dies at quit, and
 * reported dirty but reverted on screen is the user's edit gone regardless.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import VariableTableEditor from "./VariableTableEditor";
import { TooltipProvider } from "@/components/ui";
import type { Collection, VariableValue } from "@/types";

interface MutateOptions {
	onSuccess: () => void;
	onError: (error: Error) => void;
}

/** The save that is "in flight" - resolved by hand, so the window stays open. */
let pendingSave: { payload: { variables: Record<string, VariableValue> }; opts: MutateOptions };
const updateCollection = vi.fn(
	(payload: { variables: Record<string, VariableValue> }, opts: MutateOptions) => {
		pendingSave = { payload, opts };
	}
);

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: undefined, isLoading: false, error: null }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useSetActiveEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
	useDeleteEnvironmentMutation: () => ({
		mutate: vi.fn(),
		mutateAsync: vi.fn(),
		isPending: false,
	}),
	useUpdateCollectionMutation: () => ({
		mutate: (...args: unknown[]) =>
			updateCollection(...(args as Parameters<typeof updateCollection>)),
		mutateAsync: vi.fn(),
	}),
}));

const sessionStore = { activeEnvironmentId: null, setActiveEnvironmentId: vi.fn() };

/** Every `hasPendingChanges` the editor has published to the save store. */
const pendingChangesReported: boolean[] = [];
const saveStore = {
	registerContext: vi.fn(),
	unregisterContext: vi.fn(),
	updateContext: vi.fn((_id: string, updates: { hasPendingChanges?: boolean }) => {
		if (updates.hasPendingChanges !== undefined) {
			pendingChangesReported.push(updates.hasPendingChanges);
		}
	}),
	setActiveContext: vi.fn(),
	markPendingSave: vi.fn(),
	startSaving: vi.fn(),
	completeSave: vi.fn(),
	failSave: vi.fn(),
	setStatus: vi.fn(),
};

vi.mock("@/stores", () => ({
	useSaveStore: () => saveStore,
	useSessionStore: Object.assign(() => sessionStore, { getState: () => sessionStore }),
}));

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

function makeCollection(variables: Record<string, VariableValue>): Collection {
	return {
		id: "col_1",
		name: "demo",
		description: "",
		order: 0,
		variables,
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	};
}

const initial = makeCollection({
	host: { value: "example.com", enabled: true, secret: false, type: "string", createdAt: 1000 },
	token: { value: "abc", enabled: true, secret: false, type: "string", createdAt: 2000 },
});

/** The most recent `hasPendingChanges` the editor published. */
function lastReported(): boolean | undefined {
	return pendingChangesReported[pendingChangesReported.length - 1];
}

/** Rows render in `createdAt` order, then the trailing blank row. */
function valueInputs(): HTMLInputElement[] {
	return screen.getAllByPlaceholderText("value") as HTMLInputElement[];
}

describe("variables editor - an edit made while a save is in flight", () => {
	beforeEach(() => {
		updateCollection.mockClear();
		pendingChangesReported.length = 0;
	});

	it("survives the cache echo of the earlier save, and stays dirty", () => {
		const { rerender } = render(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "collection", collection: initial }} />
			</TooltipProvider>
		);

		// Row A: edit and blur, which starts a save carrying only this change.
		const [hostValue] = valueInputs();
		fireEvent.change(hostValue, { target: { value: "example.org" } });
		fireEvent.blur(hostValue);
		expect(updateCollection).toHaveBeenCalledTimes(1);
		expect(pendingSave.payload.variables.host.value).toBe("example.org");
		expect(pendingSave.payload.variables.token.value).toBe("abc");

		// Row B: typed before the save lands, so it is not in the flying payload.
		fireEvent.change(valueInputs()[1], { target: { value: "xyz" } });

		// The save lands: `onSuccess` fires and the query cache is written with
		// the server's copy, which arrives back as a new `collection` prop.
		act(() => pendingSave.opts.onSuccess());
		rerender(
			<TooltipProvider>
				<VariableTableEditor
					config={{
						type: "collection",
						collection: makeCollection({
							host: {
								value: "example.org",
								enabled: true,
								secret: false,
								type: "string",
								createdAt: 1000,
							},
							token: {
								value: "abc",
								enabled: true,
								secret: false,
								type: "string",
								createdAt: 2000,
							},
						}),
					}}
				/>
			</TooltipProvider>
		);

		expect(valueInputs()[1].value).toBe("xyz");
		expect(lastReported()).toBe(true);
	});

	it("does clear the dirty flag when nothing was typed during the save", () => {
		// The other side of the compare-and-clear: an editor that stays dirty
		// forever would re-save on every blur and never settle.
		render(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "collection", collection: initial }} />
			</TooltipProvider>
		);

		const [hostValue] = valueInputs();
		fireEvent.change(hostValue, { target: { value: "example.org" } });
		fireEvent.blur(hostValue);
		act(() => pendingSave.opts.onSuccess());

		expect(lastReported()).toBe(false);
	});

	it("still adopts a different scope's variables over an uncommitted edit", () => {
		// The guard is "ignore echoes of my own scope", not "ignore the props".
		// Switching to another collection must reseed even while dirty, or the
		// editor would show the previous collection's rows.
		const { rerender } = render(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "collection", collection: initial }} />
			</TooltipProvider>
		);

		fireEvent.change(valueInputs()[0], { target: { value: "typed-but-unsaved" } });

		const other = makeCollection({
			region: {
				value: "eu-west-1",
				enabled: true,
				secret: false,
				type: "string",
				createdAt: 1000,
			},
		});
		other.id = "col_2";
		rerender(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "collection", collection: other }} />
			</TooltipProvider>
		);

		expect(screen.getByDisplayValue("eu-west-1")).toBeTruthy();
		expect(screen.queryByDisplayValue("typed-but-unsaved")).toBeNull();
	});
});
