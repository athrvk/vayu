/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The store holds one status for the whole app, so the rule is that only the
 * context which set a status clears it.
 *
 * `completeSaveThenIdle` is where that rule lives for a *success*, and it has
 * two halves. The status check keeps its reset off anything another surface
 * published in the meantime - the failure case below is what the Dock looked
 * like before: blank, next to a toast about a failure that had just happened.
 * The generation check keeps it off a *later* save's "saved", which is the half
 * `useSaveManager` used to hand-roll by clearing its own timer before arming the
 * next one; the four other callers never had it at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { TIMING } from "@/config/timing";
import { useSaveStore } from "./save-store";
import { useToastStore } from "./toast-store";

describe("completeSaveThenIdle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useToastStore.setState({ toasts: [] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows 'saved' and returns to idle once nothing else has happened", () => {
		useSaveStore.getState().completeSaveThenIdle();
		expect(useSaveStore.getState().status).toBe("saved");

		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS - 1);
		expect(useSaveStore.getState().status).toBe("saved");

		vi.advanceTimersByTime(1);
		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("leaves a failure another context published on screen", () => {
		useSaveStore.getState().completeSaveThenIdle();

		useSaveStore.getState().failSave("delete failed");
		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);

		expect(useSaveStore.getState().status).toBe("error");
	});

	it("leaves a 'pending' from an edit made since", () => {
		// "Unsaved changes" in the Dock is the only thing in the app that says so
		// when auto-save is off, and it is not this save's to clear.
		useSaveStore.getState().completeSaveThenIdle();

		useSaveStore.getState().markPendingSave();
		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);

		expect(useSaveStore.getState().status).toBe("pending");
	});

	it("does not let an earlier save cut a later one's indicator short", () => {
		useSaveStore.getState().completeSaveThenIdle();
		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS / 2);

		// A second save lands while the first indicator is still up. It gets the
		// full duration, measured from itself.
		useSaveStore.getState().completeSaveThenIdle();
		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS / 2);
		expect(useSaveStore.getState().status).toBe("saved");

		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS / 2);
		expect(useSaveStore.getState().status).toBe("idle");
	});
});
