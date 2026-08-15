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
 * Per-row UI state has to belong to the row, not to the position it happens to
 * occupy.
 *
 * Reveal state lives inside `SecretInput`, so it is React's reconciliation that
 * decides which row owns it. The table keyed its rows by array index, and an
 * index is exactly what a delete changes: removing a revealed secret left its
 * mounted field in place for the row that shifted up, which then rendered
 * **unmasked** - a secret the user never asked to see (#621). Rows now carry an
 * editor-local id and are keyed by it.
 *
 * The id also has to be *stable*, which is the second half of this file. A
 * reseed - almost always the cache echo of a save this editor just made - must
 * hand each row back the id it already had, or every row remounts and the fix
 * turns into a different bug: a revealed secret re-masking itself, and focus
 * dropping out of the field being typed in, whenever any save lands. A switch
 * to another scope is the one case that must mint fresh ids, since those are
 * different rows that merely share names.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import VariableTableEditor from "./VariableTableEditor";
import { TooltipProvider } from "@/components/ui";
import type { Collection, VariableValue } from "@/types";

interface MutateOptions {
	onSuccess: () => void;
	onError: (error: Error) => void;
}

const savedPayloads: { variables: Record<string, VariableValue> }[] = [];
const updateCollection = vi.fn(
	(payload: { variables: Record<string, VariableValue> }, _opts: MutateOptions) => {
		savedPayloads.push(payload);
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

vi.mock("@/stores", () => ({
	useSaveStore: () => ({
		registerContext: vi.fn(),
		unregisterContext: vi.fn(),
		updateContext: vi.fn(),
		setActiveContext: vi.fn(),
		markPendingSave: vi.fn(),
		startSaving: vi.fn(),
		completeSaveThenIdle: vi.fn(),
		failSave: vi.fn(),
		setStatus: vi.fn(),
	}),
	useSessionStore: Object.assign(() => sessionStore, { getState: () => sessionStore }),
}));

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

function secret(value: string, createdAt: number): VariableValue {
	return { value, enabled: true, secret: true, type: "string", createdAt };
}

/** Two secret rows, `alpha` above `beta` (rows sort by `createdAt`). */
function twoSecrets(id = "col_1"): Collection {
	return {
		id,
		name: "demo",
		description: "",
		order: 0,
		variables: {
			alpha: secret("alpha-value", 1000),
			beta: secret("beta-value", 2000),
		},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	};
}

function renderEditor(collection: Collection) {
	return render(
		<TooltipProvider>
			<VariableTableEditor config={{ type: "collection", collection }} />
		</TooltipProvider>
	);
}

/** Value fields in row order; the trailing blank row's field comes last. */
function valueFields(): HTMLInputElement[] {
	return screen.getAllByPlaceholderText("value") as HTMLInputElement[];
}

/**
 * Whether the field holding `value` is currently masked.
 *
 * Read off the input's `type` rather than off the toggle's label, because the
 * masking is what the user sees and what a screen reader announces - a toggle
 * that says "Show value" over a plain-text field would still be a leak.
 */
function isMasked(value: string): boolean {
	const field = valueFields().find((input) => input.value === value);
	if (!field) throw new Error(`no field holds "${value}" - the table markup changed`);
	return field.type === "password";
}

function reveal(rowValue: string): void {
	const field = valueFields().find((input) => input.value === rowValue);
	if (!field) throw new Error(`no field holds "${rowValue}"`);
	const toggle = field.parentElement?.querySelector("button");
	if (!toggle) throw new Error("the secret cell rendered no reveal toggle");
	fireEvent.click(toggle);
}

describe("variables editor - per-row reveal state is keyed by row, not by position", () => {
	beforeEach(() => {
		updateCollection.mockClear();
		savedPayloads.length = 0;
	});

	it("leaves the row that shifts up masked when a revealed row is deleted", () => {
		renderEditor(twoSecrets());

		reveal("alpha-value");
		expect(isMasked("alpha-value")).toBe(false);
		expect(isMasked("beta-value")).toBe(true);

		// Delete `alpha`, the revealed one. `beta` moves into its position.
		fireEvent.click(screen.getAllByRole("button", { name: "Delete variable" })[0]);

		expect(screen.queryByDisplayValue("alpha-value")).toBeNull();
		expect(isMasked("beta-value")).toBe(true);
	});

	it("keeps reveal state on the row it belongs to when the row above is deleted", () => {
		// The mirror case: the survivor's *own* reveal must not be dropped
		// either. Keying by id has to move state with the row in both directions.
		renderEditor(twoSecrets());

		reveal("beta-value");
		fireEvent.click(screen.getAllByRole("button", { name: "Delete variable" })[0]);

		expect(isMasked("beta-value")).toBe(false);
	});

	it("keeps a revealed row revealed when it is renamed", () => {
		// Pins the failure mode of the obvious shortcut - keying rows by their
		// name. A name is editable, so it would hand the reveal to whatever the
		// row was called a keystroke ago and re-mask the field mid-rename.
		renderEditor(twoSecrets());

		reveal("beta-value");
		const keyField = screen.getAllByPlaceholderText("variable_name")[1];
		fireEvent.change(keyField, { target: { value: "beta_renamed" } });

		expect(isMasked("beta-value")).toBe(false);
	});

	it("keeps a revealed row revealed across the cache echo of a save", () => {
		// A save's `onSuccess` writes the query cache, which arrives back as a
		// new `collection` prop and reseeds the rows. The rows are the same rows,
		// so they keep their ids - otherwise every save would silently re-mask a
		// revealed secret and pull focus out of the field being edited.
		const { rerender } = renderEditor(twoSecrets());

		reveal("alpha-value");
		rerender(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "collection", collection: twoSecrets() }} />
			</TooltipProvider>
		);

		expect(isMasked("alpha-value")).toBe(false);
	});

	it("masks everything again when a different scope is loaded", () => {
		// The other side of carrying ids: another collection's rows are different
		// rows even where the names match, so they mount fresh and masked.
		const { rerender } = renderEditor(twoSecrets());

		reveal("alpha-value");
		rerender(
			<TooltipProvider>
				<VariableTableEditor
					config={{ type: "collection", collection: twoSecrets("col_2") }}
				/>
			</TooltipProvider>
		);

		expect(isMasked("alpha-value")).toBe(true);
	});

	it("never writes a row id into the saved variables", () => {
		// Ids are UI state. A save builds its payload field by field, so this is
		// a guard on that staying true rather than on a filter somewhere.
		renderEditor(twoSecrets());

		fireEvent.click(screen.getAllByRole("checkbox")[0]);

		expect(savedPayloads).toHaveLength(1);
		const saved = Object.values(savedPayloads[0].variables);
		expect(saved).toHaveLength(2);
		for (const entry of saved) {
			expect(Object.keys(entry).sort()).toEqual([
				"createdAt",
				"enabled",
				"secret",
				"type",
				"value",
			]);
		}
	});
});
