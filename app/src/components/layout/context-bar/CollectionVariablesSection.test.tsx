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
 * The collection tab's variables section: what it lists, and where an edit
 * lands.
 *
 * The commit path itself is pinned once, on the request tab
 * (`VariablesSection.commit-scope.test.tsx`) - both sections call the same
 * `useVariableCommit`. What is this section's own is the list it feeds it: its
 * rows are this collection's *definitions*, not a resolved set, so the target
 * of an edit is this collection and no ancestor of it. Mutation-check: point
 * the row's `sourceId` at anything else and the commit case reddens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollectionVariablesSection } from "./CollectionVariablesSection";
import { TooltipProvider } from "@/components/ui";
import { queryKeys } from "@/queries/keys";
import type { Collection, VariableValue } from "@/types";

const collectionMutate = vi.fn();

let collections: Collection[] = [];
let collectionsLoading = false;

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ data: collections, isLoading: collectionsLoading }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useUpdateCollectionMutation: () => ({ mutate: collectionMutate }),
}));

// Only the save store is read by the commit path; the real one is kept so the
// registration it performs is the real registration.
vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	return { useSaveStore: saveStore.useSaveStore };
});

const TAB = { id: "t1", type: "collection", entityId: "col_1" } as const;

const def = (value: string, extra: Partial<VariableValue> = {}): VariableValue => ({
	value,
	enabled: true,
	...extra,
});

const collection = (id: string, variables: Record<string, VariableValue>): Collection => ({
	id,
	name: id,
	description: "",
	order: 0,
	variables,
	auth: { mode: "none" },
	preRequestScript: "",
	postRequestScript: "",
	createdAt: "",
	updatedAt: "",
});

function renderSection() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(queryKeys.collections.list(), collections);
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<CollectionVariablesSection tab={TAB} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	collectionMutate.mockClear();
	collectionsLoading = false;
	collections = [];
});

describe("CollectionVariablesSection - what it lists", () => {
	it("lists this collection's own definitions, not an ancestor's", () => {
		collections = [
			collection("col_parent", { host: def("parent.example.com") }),
			collection("col_1", { host: def("child.example.com"), token: def("t") }),
		];
		renderSection();

		expect(screen.getByRole("textbox", { name: "Value of host" })).toHaveValue(
			"child.example.com"
		);
		expect(screen.getByRole("textbox", { name: "Value of token" })).toHaveValue("t");
	});

	it("keeps a disabled definition on screen and says it is off", () => {
		// It is still defined here - the section's question - it is simply not
		// sent. Dropping it would answer the question wrongly.
		collections = [collection("col_1", { legacy: def("x", { enabled: false }) })];
		renderSection();

		expect(screen.getByRole("textbox", { name: "Value of legacy" })).toHaveValue("x");
		expect(screen.getByText("off")).toBeInTheDocument();
	});

	it("masks a secret read-only, as the request tab's list does", () => {
		collections = [collection("col_1", { key: def("s3cret", { secret: true }) })];
		renderSection();

		// The shared `SecretInput` (#1308): masked `type=password`, read-only, and
		// reached by label since a password input carries no textbox role. The
		// collection tab reuses `VariableRow`, so it gets the reveal for free.
		const input = screen.getByLabelText("Value of key");
		expect(input).toHaveAttribute("readonly");
		expect(input).toHaveAttribute("type", "password");
	});

	it("says so when the collection defines none", () => {
		collections = [collection("col_1", {})];
		renderSection();
		expect(screen.getByText("This collection defines no variables")).toBeInTheDocument();
	});

	it("says the collection is gone rather than claiming it has no variables", () => {
		collections = [collection("col_other", { host: def("x") })];
		renderSection();
		expect(screen.getByText("This collection is no longer available")).toBeInTheDocument();
	});

	it("waits rather than declaring a collection missing while the list is in flight", () => {
		collectionsLoading = true;
		renderSection();
		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});
});

describe("CollectionVariablesSection - where an edit lands", () => {
	it("commits into this collection, carrying its other definitions verbatim", () => {
		collections = [
			collection("col_parent", { host: def("parent.example.com") }),
			collection("col_1", {
				host: def("child.example.com"),
				token: def("t", { secret: false, enabled: true }),
			}),
		];
		renderSection();

		const input = screen.getByRole("textbox", { name: "Value of host" });
		act(() => {
			fireEvent.change(input, { target: { value: "edited.example.com" } });
			fireEvent.blur(input);
		});

		expect(collectionMutate).toHaveBeenCalledTimes(1);
		const [payload] = collectionMutate.mock.calls[0] as [
			{ id: string; variables: Record<string, VariableValue> },
		];
		expect(payload.id).toBe("col_1");
		expect(payload.variables.host.value).toBe("edited.example.com");
		expect(payload.variables.token).toEqual(def("t", { secret: false, enabled: true }));
	});

	it("leaves a disabled definition disabled when its value is edited", () => {
		// The commit spreads the stored definition, so the row's own flags ride
		// along. An edit that quietly re-enabled it would send a variable the
		// user had switched off.
		collections = [collection("col_1", { legacy: def("x", { enabled: false }) })];
		renderSection();

		const input = screen.getByRole("textbox", { name: "Value of legacy" });
		act(() => {
			fireEvent.change(input, { target: { value: "y" } });
			fireEvent.blur(input);
		});

		const [payload] = collectionMutate.mock.calls[0] as [
			{ variables: Record<string, VariableValue> },
		];
		expect(payload.variables.legacy).toEqual({ value: "y", enabled: false });
	});

	it("sends nothing when the value comes back unchanged", () => {
		collections = [collection("col_1", { host: def("example.com") })];
		renderSection();

		const input = screen.getByRole("textbox", { name: "Value of host" });
		act(() => {
			fireEvent.change(input, { target: { value: "other" } });
			fireEvent.change(input, { target: { value: "example.com" } });
			fireEvent.blur(input);
		});

		expect(collectionMutate).not.toHaveBeenCalled();
	});
});
