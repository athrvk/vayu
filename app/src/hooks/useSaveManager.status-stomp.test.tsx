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
 * An auto-save's "Saved" must not take an unrelated failure down with it.
 *
 * `performSave` reported success as `completeSave()` plus its own
 * `setTimeout(() => setStatus("idle"))`. That timer fired regardless of what
 * had happened since: a failed delete published to the Dock in the meantime was
 * simply erased, leaving the Dock blank beside the failure's toast. It goes
 * through `completeSaveThenIdle` now, which resets only its own `saved`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { TIMING } from "@/config/timing";
import { useClientSettingsStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";
import { useToastStore } from "@/stores/toast-store";
import { useSaveManager } from "./useSaveManager";

function mountManager(onSave: () => Promise<void>) {
	return renderHook(() =>
		useSaveManager({ entityId: "req_1", contextName: "Request", onSave, hasChanges: true })
	);
}

describe("the status timer a request save arms", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
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
		act(() => useSaveStore.getState().failSave("delete failed"));
		await act(async () => {
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		});

		expect(useSaveStore.getState().status).toBe("error");
	});
});
