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
 * A field the table has no column for survives an edit.
 *
 * A Postman import stores a collection variable's `description` beside its
 * value. The table built each row from the five fields it shows and wrote a
 * save back from the same five, so editing the value silently dropped the
 * description. The row carries the rest now.
 *
 * Mutation-check: drop `...row.extra` from `toVariableValue` and the saved
 * value loses its description.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui";
import VariableTableEditor from "./VariableTableEditor";
import type { Collection, VariableValue } from "@/types";

const updateCollection = vi.fn();

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
		mutate: (...args: unknown[]) => updateCollection(...args),
		mutateAsync: vi.fn(),
	}),
}));

const sessionStore = { activeEnvironmentId: null, setActiveEnvironmentId: vi.fn() };

vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	return {
		useSaveStore: saveStore.useSaveStore,
		useSessionStore: Object.assign(() => sessionStore, { getState: () => sessionStore }),
	};
});

vi.mock("@/modules/variables/variables-store", () => ({
	useVariablesStore: () => ({ selectedCategory: null, setSelectedCategory: vi.fn() }),
}));

const collection: Collection = {
	id: "col_1",
	name: "demo",
	description: "",
	order: 0,
	variables: {
		host: {
			value: "example.com",
			enabled: true,
			secret: false,
			type: "string",
			createdAt: 1000,
			description: "The API's host, without a scheme",
		} as VariableValue,
	},
	auth: { mode: "none" },
	elements: [],
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

describe("a variable field the table has no column for", () => {
	it("is written back when the variable is edited", () => {
		render(
			<TooltipProvider>
				<VariableTableEditor config={{ type: "collection", collection }} />
			</TooltipProvider>
		);

		const [hostValue] = screen.getAllByPlaceholderText("value") as HTMLInputElement[];
		fireEvent.change(hostValue, { target: { value: "example.org" } });
		fireEvent.blur(hostValue);

		expect(updateCollection).toHaveBeenCalledTimes(1);
		const payload = updateCollection.mock.calls[0][0] as {
			variables: Record<string, VariableValue & { description?: string }>;
		};
		expect(payload.variables.host).toEqual({
			value: "example.org",
			enabled: true,
			secret: false,
			type: "string",
			createdAt: 1000,
			description: "The API's host, without a scheme",
		});
	});
});
