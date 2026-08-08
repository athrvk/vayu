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
 * A variable save's "Saved" must not take an unrelated failure down with it.
 *
 * `finishSave` reported success as `completeSave()` plus its own
 * `setTimeout(() => setStatus("idle"))`, which fired regardless of what had
 * happened since - clearing an error another surface had published to the Dock,
 * or a `pending` from an edit typed in the meantime. It goes through
 * `completeSaveThenIdle` now, which resets only its own `saved`.
 *
 * The harness is `concurrent-edit-clobber.test.tsx`'s, with the real save store
 * in place of the mocked one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

import { TIMING } from "@/config/timing";
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
		} as VariableValue,
	},
	auth: { mode: "none" },
	preRequestScript: "",
	postRequestScript: "",
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

/** Edit a row and blur it, which is what starts a save, then land the save. */
function saveOnce() {
	render(
		<TooltipProvider>
			<VariableTableEditor config={{ type: "collection", collection }} />
		</TooltipProvider>
	);

	const [hostValue] = screen.getAllByPlaceholderText("value") as HTMLInputElement[];
	fireEvent.change(hostValue, { target: { value: "example.org" } });
	fireEvent.blur(hostValue);
	expect(updateCollection).toHaveBeenCalledTimes(1);

	act(() => pendingSave.opts.onSuccess());
	expect(useSaveStore.getState().status).toBe("saved");
}

describe("the status timer a variable save arms", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		updateCollection.mockClear();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useToastStore.setState({ toasts: [] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns the Dock to idle when nothing else has happened", async () => {
		saveOnce();

		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("leaves a failure that arrived meanwhile on screen", async () => {
		saveOnce();

		act(() => useSaveStore.getState().failSave("delete failed"));
		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		expect(useSaveStore.getState().status).toBe("error");
	});
});
