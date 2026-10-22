/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

import { ApiError } from "@/services/http-client";
import { TooltipProvider } from "@/components/ui";
import { useSaveStore } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import VariableTableEditor from "./VariableTableEditor";
import type { Collection, VariableValue } from "@/types";

interface MutateOptions {
	onSuccess: () => void;
	onError: (error: Error) => void;
}

/** The save in flight - resolved by hand, so the test owns when it lands. */
let pendingSave: { opts: MutateOptions };
const updateCollection = vi.fn((_payload: unknown, opts: MutateOptions) => {
	pendingSave = { opts };
});

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

// The editor reads the save store through `@/stores`, so the barrel is mocked
// with the real store rather than a set of spies.
vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	// `VariableRow`'s "Copy for agent" button reads the toast store through `useCopy`.
	const toastStore =
		await vi.importActual<typeof import("@/stores/toast-store")>("@/stores/toast-store");
	return {
		useSaveStore: saveStore.useSaveStore,
		useToastStore: toastStore.useToastStore,
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
		} as VariableValue,
	},
	auth: { mode: "none" },
	elements: [],
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

/**
 * A variable save the engine refused with a 507 is reported to the store as
 * disk-full by the call site itself (#2685).
 *
 * The flush also reaches the same verdict through its own catch (the save
 * rejects), which then publishes the failure a second time; so the assertion
 * reads the *first* error the store was given, the one `performSave`'s
 * `onError` published.
 */

/** Edit a row, run the quit-time flush, and fail the write in flight. */
async function failFlushedSave(error: Error) {
	render(
		<TooltipProvider>
			<VariableTableEditor config={{ type: "collection", collection }} />
		</TooltipProvider>
	);
	const [hostValue] = screen.getAllByPlaceholderText("value") as HTMLInputElement[];
	fireEvent.change(hostValue, { target: { value: "example.org" } });

	const published: boolean[] = [];
	const unsubscribe = useSaveStore.subscribe((state, previous) => {
		if (state.status === "error" && state.lastErrorMessage !== previous.lastErrorMessage) {
			published.push(state.lastErrorDiskFull);
		}
	});
	let flushed!: Awaited<ReturnType<ReturnType<typeof useSaveStore.getState>["flushAll"]>>;
	await act(async () => {
		const flush = useSaveStore.getState().flushAll();
		expect(updateCollection).toHaveBeenCalledTimes(1);
		pendingSave.opts.onError(error);
		flushed = await flush;
	});
	unsubscribe();
	return { published, flushed };
}

describe("a variable save refused at quit", () => {
	beforeEach(() => {
		updateCollection.mockClear();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useSaveStore.getState().reset();
		useToastStore.setState({ toasts: [] });
	});

	it("hands the 507 to failSave", async () => {
		const { published, flushed } = await failFlushedSave(
			new ApiError(507, "insufficient_storage", "The disk holding Vayu's data is full")
		);

		expect(published[0]).toBe(true);
		expect(flushed).toMatchObject({ failed: 1, reason: "disk-full" });
	});

	it("hands it nothing for any other failure", async () => {
		const { published, flushed } = await failFlushedSave(
			new ApiError(503, "unavailable", "busy")
		);

		expect(published[0]).toBe(false);
		expect(flushed).toEqual({ saved: 0, failed: 1, pending: 0 });
	});
});
