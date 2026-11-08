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
 * What a variable save leaves on the Dock, against the real save store.
 *
 * The editor reports under its own context id, so its "Saved" cannot take
 * another surface's failure down with it, and a failure it reports and then
 * rejects is toasted once rather than again by `runSave` (#3350).
 *
 * The harness is `concurrent-edit-clobber.test.tsx`'s, with the real save store
 * in place of the mocked one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";

import { TIMING } from "@/config/timing";
import { TooltipProvider } from "@/components/ui";
import { resetSaveStoreForTests, useSaveStore } from "@/stores/save-store";
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
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
	// A failed save reads the auto-save delay its retry backs off from.
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
		} as VariableValue,
	},
	auth: { mode: "none" },
	elements: [],
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
};

const otherCollection: Collection = { ...collection, id: "col_2", name: "other" };

const editorFor = (source: Collection) => (
	<TooltipProvider>
		<VariableTableEditor config={{ type: "collection", collection: source }} />
	</TooltipProvider>
);

function renderEditor() {
	return render(editorFor(collection));
}

const hostValue = () => (screen.getAllByPlaceholderText("value") as HTMLInputElement[])[0];
const store = () => useSaveStore.getState();

/** Edit a row and blur it, which is what starts a save, then land the save. */
function saveOnce() {
	renderEditor();
	fireEvent.change(hostValue(), { target: { value: "example.org" } });
	fireEvent.blur(hostValue());
	expect(updateCollection).toHaveBeenCalledTimes(1);

	act(() => pendingSave.opts.onSuccess());
	expect(useSaveStore.getState().status).toBe("saved");
}

describe("the status timer a variable save arms", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		updateCollection.mockClear();
		resetSaveStoreForTests();
		useToastStore.setState({ toasts: [] });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
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

		act(() => store().reportFailed("settings", "Couldn't save settings - busy"));
		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		expect(useSaveStore.getState().status).toBe("error");
	});

	/*
	 * Effect 5 of #3350: `onError` reported the failure and then rejected, and
	 * `runSave` published the rejection again in its own words. Mutation
	 * check: report under any id but the editor's own and this reds - two toasts.
	 */
	it("raises one toast for a failed save the store ran", async () => {
		// Counted at the call: the toast store folds an identical second message
		// into the first, which would hide a duplicate worded the same way.
		const showToast = vi.spyOn(useToastStore.getState(), "showToast");
		renderEditor();
		fireEvent.change(hostValue(), { target: { value: "example.org" } });

		let flushed!: ReturnType<ReturnType<typeof store>["flushAll"]>;
		act(() => {
			flushed = store().flushAll();
		});
		await act(async () => {
			pendingSave.opts.onError(new Error("database is locked"));
			await flushed;
		});

		expect(await flushed).toEqual({ saved: 0, failed: 1, pending: 0 });
		expect(showToast).toHaveBeenCalledTimes(1);
		expect(showToast).toHaveBeenCalledWith("Couldn't save - database is locked", "error");
		expect(store().status).toBe("error");
	});

	/*
	 * Mutation check: report saved whenever the save lands and this reds - the
	 * Dock says "Saved" over the edit typed while it was in flight.
	 */
	it("says Unsaved changes for an edit typed while the save was in flight", () => {
		renderEditor();
		fireEvent.change(hostValue(), { target: { value: "example.org" } });
		fireEvent.blur(hostValue());
		fireEvent.change(hostValue(), { target: { value: "example.net" } });

		act(() => pendingSave.opts.onSuccess());

		expect(store().status).toBe("pending");
	});

	/*
	 * Mutation check: drop the editor's unmount `discard` and this reds - the
	 * Dock keeps "Unsaved changes" for rows nothing holds any more.
	 */
	it("withdraws its report when it unmounts holding an unsent edit", () => {
		const { unmount } = renderEditor();
		fireEvent.change(hostValue(), { target: { value: "example.org" } });
		expect(store().status).toBe("pending");

		unmount();

		expect(store().status).toBe("idle");
	});

	/*
	 * Selecting another collection reseeds the rows and discards the old id, and
	 * the save the blur started is still out. Mutation check (confirmed): with
	 * the store recording reports for an abandoned id, the first case sits on
	 * "Not saved" and the second on "Unsaved changes", both for `collection-col_1`
	 * rows nobody holds.
	 */
	describe("a save that lands after the editor switched collections", () => {
		function switchAway(view: ReturnType<typeof renderEditor>) {
			view.rerender(editorFor(otherCollection));
			expect(store().unsaved.has("collection-col_1")).toBe(false);
		}

		// Through the store's flush rather than a blur, whose save nothing awaits:
		// this is also the case that would toast twice, once from the editor and
		// once from `runSave`, if the store judged "already reported" by an entry
		// the discard has taken.
		it("is one toast, not 'Not saved', when it fails", async () => {
			const showToast = vi.spyOn(useToastStore.getState(), "showToast");
			// The toast store's state object outlives `restoreAllMocks` (zustand
			// merges it), so `spyOn` can hand back the earlier case's spy, calls and all.
			showToast.mockClear();
			const view = renderEditor();
			fireEvent.change(hostValue(), { target: { value: "example.org" } });
			let flushed!: ReturnType<ReturnType<typeof store>["flushAll"]>;
			act(() => {
				flushed = store().flushAll();
			});
			switchAway(view);

			await act(async () => {
				pendingSave.opts.onError(new Error("database is locked"));
				await flushed;
			});

			expect(await flushed).toEqual({ saved: 0, failed: 1, pending: 0 });
			expect(showToast).toHaveBeenCalledTimes(1);
			expect(store().unsaved.has("collection-col_1")).toBe(false);
			expect(store().status).toBe("idle");
		});

		it("leaves no 'Unsaved changes' when it succeeds", () => {
			const view = renderEditor();
			fireEvent.change(hostValue(), { target: { value: "example.org" } });
			fireEvent.blur(hostValue());
			switchAway(view);

			act(() => pendingSave.opts.onSuccess());

			expect(store().unsaved.has("collection-col_1")).toBe(false);
			expect(store().status).not.toBe("pending");
		});
	});
});
