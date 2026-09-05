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
 * The editor used to save its whole local copy of the variable map, so an
 * MCP agent's `update_environment` / `update_globals` / `update_collection`
 * landing while the table had an unsaved edit was silently overwritten by
 * the next blur (#1439). These pin the fix: a save merges the user's own
 * changed keys onto the freshest map instead of replacing it, so an
 * untouched external write survives regardless of what the table happens to
 * be showing, and a key both sides touched is surfaced as a conflict rather
 * than resolved either way without asking.
 *
 * The harness is `concurrent-edit-clobber.test.tsx`'s.
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

function valueInputs(): HTMLInputElement[] {
	return screen.getAllByPlaceholderText("value") as HTMLInputElement[];
}

describe("variables editor - a write that lands while the table is dirty", () => {
	beforeEach(() => {
		updateCollection.mockClear();
	});

	it("keeps an untouched agent addition through the next save, beside the user's own edit", () => {
		const initial = makeCollection({
			host: {
				value: "example.com",
				enabled: true,
				secret: false,
				type: "string",
				createdAt: 1000,
			},
		});

		const { rerender } = render(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "collection", collection: initial }} />
			</TooltipProvider>
		);

		// The user edits host but has not blurred yet - the table is dirty.
		fireEvent.change(valueInputs()[0], { target: { value: "example.org" } });

		// An agent adds "region" to the same collection. Host is untouched by
		// the agent, so the fresh map still carries the user's pre-edit value
		// for it - only "region" is new.
		rerender(
			<TooltipProvider>
				<VariableTableEditor
					config={{
						type: "collection",
						collection: makeCollection({
							host: {
								value: "example.com",
								enabled: true,
								secret: false,
								type: "string",
								createdAt: 1000,
							},
							region: {
								value: "eu-west-1",
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

		expect(screen.queryByText(/changed elsewhere/i)).toBeNull();

		// The user blurs, saving. The old bug: the payload carried the editor's
		// stale whole local map, so "region" - a key the editor never touched
		// and never even knew about at seed time - was silently dropped.
		fireEvent.blur(valueInputs()[0]);
		expect(updateCollection).toHaveBeenCalledTimes(1);
		expect(pendingSave.payload.variables.host.value).toBe("example.org");
		expect(pendingSave.payload.variables.region.value).toBe("eu-west-1");
	});

	it("does not resurrect a key an agent deleted while it was untouched by the user", () => {
		const initial = makeCollection({
			host: {
				value: "example.com",
				enabled: true,
				secret: false,
				type: "string",
				createdAt: 1000,
			},
			stale: {
				value: "gone-soon",
				enabled: true,
				secret: false,
				type: "string",
				createdAt: 2000,
			},
		});

		const { rerender } = render(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "collection", collection: initial }} />
			</TooltipProvider>
		);

		fireEvent.change(valueInputs()[0], { target: { value: "example.org" } });

		// An agent (or another tab) deletes "stale" - the editor never touched
		// that row, so its save must not write it back.
		rerender(
			<TooltipProvider>
				<VariableTableEditor
					config={{
						type: "collection",
						collection: makeCollection({
							host: {
								value: "example.com",
								enabled: true,
								secret: false,
								type: "string",
								createdAt: 1000,
							},
						}),
					}}
				/>
			</TooltipProvider>
		);

		fireEvent.blur(valueInputs()[0]);
		expect(pendingSave.payload.variables.host.value).toBe("example.org");
		expect(pendingSave.payload.variables.stale).toBeUndefined();
	});

	it("surfaces a conflict when an agent changes the key the user is editing, and keeps the user's value until they choose", () => {
		const initial = makeCollection({
			host: {
				value: "example.com",
				enabled: true,
				secret: false,
				type: "string",
				createdAt: 1000,
			},
		});

		const { rerender } = render(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "collection", collection: initial }} />
			</TooltipProvider>
		);

		fireEvent.change(valueInputs()[0], { target: { value: "mine" } });

		// An agent changes the very same key, to a different value, before the
		// user has saved.
		rerender(
			<TooltipProvider>
				<VariableTableEditor
					config={{
						type: "collection",
						collection: makeCollection({
							host: {
								value: "theirs",
								enabled: true,
								secret: false,
								type: "string",
								createdAt: 1000,
							},
						}),
					}}
				/>
			</TooltipProvider>
		);

		// The user's value is kept, and the conflict is named.
		expect(valueInputs()[0].value).toBe("mine");
		expect(screen.getByText(/changed elsewhere: host/i)).toBeTruthy();

		// A save now (blur) still keeps the user's value - it is not silently
		// discarded just because a conflict exists.
		fireEvent.blur(valueInputs()[0]);
		expect(pendingSave.payload.variables.host.value).toBe("mine");

		// The callout clears once its own save lands.
		act(() => pendingSave.opts.onSuccess());
		expect(screen.queryByText(/changed elsewhere/i)).toBeNull();
	});

	it("lets the user explicitly take the agent's value for a conflicting key", () => {
		const initial = makeCollection({
			host: {
				value: "example.com",
				enabled: true,
				secret: false,
				type: "string",
				createdAt: 1000,
			},
		});

		const { rerender } = render(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "collection", collection: initial }} />
			</TooltipProvider>
		);

		fireEvent.change(valueInputs()[0], { target: { value: "mine" } });

		rerender(
			<TooltipProvider>
				<VariableTableEditor
					config={{
						type: "collection",
						collection: makeCollection({
							host: {
								value: "theirs",
								enabled: true,
								secret: false,
								type: "string",
								createdAt: 1000,
							},
						}),
					}}
				/>
			</TooltipProvider>
		);

		act(() => {
			fireEvent.click(screen.getByRole("button", { name: /take theirs/i }));
		});

		expect(valueInputs()[0].value).toBe("theirs");
		expect(updateCollection).toHaveBeenCalledTimes(1);
		expect(pendingSave.payload.variables.host.value).toBe("theirs");
		expect(screen.queryByText(/changed elsewhere/i)).toBeNull();
	});
});
