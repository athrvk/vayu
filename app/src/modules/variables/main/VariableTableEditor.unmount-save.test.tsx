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
 * A save still out when the editor unmounts, through a real TanStack mutation.
 *
 * TanStack runs `mutate`'s per-call callbacks only while the observer has
 * listeners, so once the editor unmounts they never fire. A queue settled only
 * by them never let go of the save in flight: its promise hung, and the save
 * queued behind it was never sent (#3353). The other suites stub the mutation;
 * this one keeps the observer real so that behaviour is the one under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TooltipProvider } from "@/components/ui";
import { resetSaveStoreForTests, useSaveStore, type FlushTally } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import VariableTableEditor from "./VariableTableEditor";
import type { Collection, VariableValue } from "@/types";

interface Write {
	variables: Record<string, VariableValue>;
	land: () => void;
}

/** Every write the mutation function received, landed by hand. */
const writes: Write[] = [];
function writeCollection(payload: { variables: Record<string, VariableValue> }) {
	return new Promise<void>((resolve) => {
		writes.push({ variables: payload.variables, land: resolve });
	});
}

vi.mock("@/queries", async () => {
	const { useMutation } =
		await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
	return {
		useGlobalsQuery: () => ({ data: undefined, isLoading: false, error: null }),
		useUpdateGlobalsMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
		useUpdateEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
		useSetActiveEnvironmentMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
		useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
		useDeleteEnvironmentMutation: () => ({
			mutate: vi.fn(),
			mutateAsync: vi.fn(),
			isPending: false,
		}),
		useUpdateCollectionMutation: () => useMutation({ mutationFn: writeCollection }),
	};
});

const sessionStore = { activeEnvironmentId: null, setActiveEnvironmentId: vi.fn() };

vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	const toastStore =
		await vi.importActual<typeof import("@/stores/toast-store")>("@/stores/toast-store");
	const settingsStore = await vi.importActual<typeof import("@/stores/client-settings-store")>(
		"@/stores/client-settings-store"
	);
	return {
		useSaveStore: saveStore.useSaveStore,
		useToastStore: toastStore.useToastStore,
		useClientSettingsStore: settingsStore.useClientSettingsStore,
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
		},
	},
	auth: { mode: "none" },
	elements: [],
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

beforeEach(() => {
	writes.length = 0;
	resetSaveStoreForTests();
	useToastStore.setState({ toasts: [] });
});

describe("a save in flight when the editor unmounts", () => {
	/*
	 * Mutation check: settle only from the per-call callbacks (drop the
	 * promise's `.then` in `sendThrough`) and this reds - the queued write never
	 * goes out, and the flush never resolves.
	 */
	it("still settles, and the save queued behind it still goes out", async () => {
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const view = render(
			<QueryClientProvider client={client}>
				<TooltipProvider>
					<VariableTableEditor config={{ type: "collection", collection }} />
				</TooltipProvider>
			</QueryClientProvider>
		);
		const hostValue = screen.getAllByPlaceholderText("value")[0];
		fireEvent.change(hostValue, { target: { value: "example.org" } });

		let flushed!: Promise<FlushTally>;
		act(() => {
			flushed = useSaveStore.getState().flushAll();
		});
		await waitFor(() => expect(writes).toHaveLength(1));
		// Queued behind the write in flight.
		fireEvent.click(screen.getByRole("checkbox", { name: "Enable host" }));
		expect(writes).toHaveLength(1);

		view.unmount();
		await act(async () => {
			writes[0].land();
		});

		await waitFor(() => expect(writes).toHaveLength(2));
		expect(writes[1].variables.host).toMatchObject({ value: "example.org", enabled: false });
		expect(await flushed).toEqual({ saved: 1, failed: 0, pending: 0 });
	});
});
