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
 * An auto-save's "Saved", and a switch to another entity, must not take an
 * unrelated failure down with them.
 *
 * `performSave` reported success as `completeSave()` plus its own
 * `setTimeout(() => setStatus("idle"))`. That timer fired regardless of what
 * had happened since: a failure published to the Dock in the meantime was
 * simply erased, leaving the Dock blank beside the failure's toast. An entity
 * switch did the same through a `reset()` of the one shared status (#3350).
 * Each surface reports under its own id now, and the status is derived from
 * all of them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { TIMING } from "@/config/timing";
import { useClientSettingsStore } from "@/stores";
import { resetSaveStoreForTests, useSaveStore } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import { useSaveManager } from "./useSaveManager";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient }, children);
}

function mountManager(onSave: () => Promise<void>, initial = { entityId: "req_1" }) {
	return renderHook(
		({ entityId }: { entityId: string }) =>
			useSaveManager({
				entityId,
				contextName: "Request",
				onSave,
				hasChanges: true,
				// One edit, never revised: these cases are about the save, not the
				// debounce. `useSaveManager.debounce.test.tsx` varies the token.
				changeToken: 1,
			}),
		{ wrapper, initialProps: initial }
	);
}

describe("the status timer a request save arms", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetSaveStoreForTests();
		useToastStore.setState({ toasts: [] });
		// Auto-save off, so the only save in the test is the explicit one.
		useClientSettingsStore.setState({ autoSave: { enabled: false, delayMs: 5000 } });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function saveOnce() {
		const { result } = mountManager(() => Promise.resolve());
		await act(async () => {
			await result.current.forceSave();
		});
		expect(useSaveStore.getState().status).toBe("saved");
	}

	it("returns the Dock to idle when nothing else has happened", async () => {
		await saveOnce();

		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("leaves a failure that arrived meanwhile on screen", async () => {
		await saveOnce();

		// Anything else failing before the timer fires - a delete in the tree, a
		// settings write. The Dock is showing that error now.
		act(() => useSaveStore.getState().reportFailed("settings", "Couldn't save settings"));
		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		expect(useSaveStore.getState().status).toBe("error");
	});

	it("leaves another surface's failure on screen through an entity switch", async () => {
		// Mutation check: putting back a store-wide reset in the entity-change
		// effect, as its old `reset()` was, makes this "saved" - the switch's own
		// flush landing over the settings failure.
		act(() => useSaveStore.getState().reportFailed("settings", "Couldn't save settings"));
		const { rerender } = mountManager(() => Promise.resolve());

		await act(async () => {
			rerender({ entityId: "req_2" });
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(useSaveStore.getState().status).toBe("error");
		expect(useSaveStore.getState().lastErrorMessage).toBe("Couldn't save settings");
	});

	it("does not retry its own save because another surface failed", async () => {
		// The auto-save path read the store-wide status to decide whether its
		// own save had failed, so a success landing beside a failure elsewhere
		// was retried on the backoff. Mutation check: deciding from `status`
		// instead of the verdict calls onSave again here.
		useClientSettingsStore.setState({ autoSave: { enabled: true, delayMs: 5000 } });
		act(() => useSaveStore.getState().reportFailed("settings", "Couldn't save settings"));
		const onSave = vi.fn(() => Promise.resolve());
		mountManager(onSave);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(TIMING.SAVE_RETRY_MAX_DELAY_MS);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
	});
});
