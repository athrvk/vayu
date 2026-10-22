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
import { ApiError } from "@/services/http-client";
import { useSaveStore, type SaveOutcome } from "./save-store";
import { useToastStore } from "./toast-store";

/** A registered context, dirty or clean, with a `save` nothing in here calls. */
function registerContext(id: string, hasPendingChanges: boolean) {
	useSaveStore.getState().registerContext({
		id,
		name: id,
		save: () => Promise.resolve(),
		hasPendingChanges,
	});
}

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

/**
 * The Dock shows one status for the whole app, so "Saved" is a claim about the
 * editor and not about the round trip that just returned. `runSave` has held
 * that rule since #1381 for the contexts that go through it; the collection
 * tree's renames go through nothing, and published their success straight onto
 * the shared status - "Saved", over a Tests script the user had not saved.
 */
describe("completeSaveThenIdle with other unsaved work on screen", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useToastStore.setState({ toasts: [] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports 'pending', not 'saved', for a direct writer while a context is dirty", () => {
		registerContext("request-1", true);

		// The shape of a sidebar rename: no registered context of its own.
		useSaveStore.getState().startSaving();
		useSaveStore.getState().completeSaveThenIdle();

		expect(useSaveStore.getState().status).toBe("pending");

		// And it stays that way - the dirty context clears it when it writes.
		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		expect(useSaveStore.getState().status).toBe("pending");
	});

	it("still reports 'saved' for a direct writer when nothing else is dirty", () => {
		// The control: a guard that never completes would pass the case above.
		registerContext("request-1", false);

		useSaveStore.getState().startSaving();
		useSaveStore.getState().completeSaveThenIdle();

		expect(useSaveStore.getState().status).toBe("saved");

		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("does not hold a context's own success against it", () => {
		// A registered context's entry is refreshed by an effect, so it still
		// reads dirty at the moment it reports the write that cleaned it. Naming
		// itself is what keeps that from reading as "somebody else is dirty".
		registerContext("request-1", true);

		useSaveStore.getState().completeSaveThenIdle("request-1");

		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("clears a 'pending' it invented once the lagging registry catches up", () => {
		// Two surfaces finishing within a render of each other: each reads the
		// other's not-yet-refreshed entry as dirty, so both report `pending` over
		// an editor that holds nothing. Left alone that would describe nothing
		// until the next save.
		registerContext("request-1", true);
		useSaveStore.getState().completeSaveThenIdle("settings");
		expect(useSaveStore.getState().status).toBe("pending");

		registerContext("request-1", false);
		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);

		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("holds another context's unsaved work against a context's own success", () => {
		registerContext("request-1", true);
		registerContext("settings", true);

		useSaveStore.getState().completeSaveThenIdle("settings");

		expect(useSaveStore.getState().status).toBe("pending");
	});
});

/**
 * `flushAll` is what the quit/window-close path (#1489) and a tab close read
 * to decide whether closing would discard something - it used to resolve to
 * `undefined` regardless of what happened, so a down or hung engine at quit
 * looked identical to a clean save.
 */
describe("discardPendingSave", () => {
	beforeEach(() => {
		useSaveStore.setState({
			status: "idle",
			lastErrorMessage: null,
			contexts: new Map(),
			activeContextId: null,
		});
	});

	it("takes the Dock from pending back to idle", () => {
		registerContext("a", true);
		useSaveStore.getState().markPendingSave();

		useSaveStore.getState().discardPendingSave("a");

		expect(useSaveStore.getState().status).toBe("idle");
	});

	it("clears an error left by the discarded edit's failed save", () => {
		registerContext("a", true);
		useSaveStore.setState({ status: "error", lastErrorMessage: "boom" });

		useSaveStore.getState().discardPendingSave("a");

		expect(useSaveStore.getState().status).toBe("idle");
		expect(useSaveStore.getState().lastErrorMessage).toBeNull();
	});

	it("leaves the status to another context that still holds an edit", () => {
		registerContext("a", true);
		registerContext("b", true);
		useSaveStore.getState().markPendingSave();

		useSaveStore.getState().discardPendingSave("a");

		expect(useSaveStore.getState().status).toBe("pending");
	});

	it("leaves a save in flight or just landed alone", () => {
		registerContext("a", true);
		for (const status of ["saving", "saved"] as const) {
			useSaveStore.setState({ status });
			useSaveStore.getState().discardPendingSave("a");
			expect(useSaveStore.getState().status).toBe(status);
		}
	});
});

describe("flushAll", () => {
	beforeEach(() => {
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		useToastStore.setState({ toasts: [] });
	});

	it("reports nothing when nothing is dirty", async () => {
		registerContext("request-1", false);
		await expect(useSaveStore.getState().flushAll()).resolves.toEqual({
			saved: 0,
			failed: 0,
			pending: 0,
		});
	});

	it("counts every dirty context that saved clean", async () => {
		registerContext("request-1", true);
		registerContext("settings", true);
		await expect(useSaveStore.getState().flushAll()).resolves.toEqual({
			saved: 2,
			failed: 0,
			pending: 0,
		});
	});

	it("counts a rejecting save as failed, not saved", async () => {
		registerContext("request-1", true);
		useSaveStore.getState().registerContext({
			id: "settings",
			name: "settings",
			save: () => Promise.reject(new Error("network error")),
			hasPendingChanges: true,
		});

		await expect(useSaveStore.getState().flushAll()).resolves.toEqual({
			saved: 1,
			failed: 1,
			pending: 0,
		});
	});

	it("counts a context that resolves 'final' as failed, so the quit prompt still asks (#1889)", async () => {
		useSaveStore.getState().registerContext({
			id: "request-1",
			name: "request-1",
			save: () => {
				useSaveStore.getState().failSave("Couldn't save - bad request");
				return Promise.resolve("final");
			},
			hasPendingChanges: true,
		});

		await expect(useSaveStore.getState().flushAll()).resolves.toEqual({
			saved: 0,
			failed: 1,
			pending: 0,
		});
	});

	describe("naming the cause of a failure (#2423)", () => {
		const registerOutcome = (id: string, outcome: SaveOutcome) => {
			useSaveStore.getState().registerContext({
				id,
				name: id,
				save: () => {
					useSaveStore.getState().failSave(`Couldn't save ${id}`);
					return Promise.resolve(outcome);
				},
				hasPendingChanges: true,
			});
		};

		it("carries 'disk-full' when it explains the only failure", async () => {
			registerOutcome("request-1", "disk-full");

			await expect(useSaveStore.getState().flushAll()).resolves.toEqual({
				saved: 0,
				failed: 1,
				pending: 0,
				reason: "disk-full",
			});
		});

		it("carries 'disk-full' when it explains every one of several failures", async () => {
			registerOutcome("request-1", "disk-full");
			registerOutcome("request-2", "disk-full");

			await expect(useSaveStore.getState().flushAll()).resolves.toEqual({
				saved: 0,
				failed: 2,
				pending: 0,
				reason: "disk-full",
			});
		});

		it("names no cause when another failure sits beside a disk-full one", async () => {
			registerOutcome("request-1", "disk-full");
			registerOutcome("request-2", "failed");

			const result = await useSaveStore.getState().flushAll();

			expect(result).toEqual({ saved: 0, failed: 2, pending: 0 });
			expect(result).not.toHaveProperty("reason");
		});

		it("names no cause for a disk-full failure beside a 'final' one", async () => {
			registerOutcome("request-1", "disk-full");
			registerOutcome("request-2", "final");

			expect(await useSaveStore.getState().flushAll()).not.toHaveProperty("reason");
		});

		it("keeps the cause when the failure sits beside a saved or pending context", async () => {
			// Each reports its own verdict: a silent context would be judged by the
			// shared status, which the failing sibling has already set to "error".
			useSaveStore.getState().registerContext({
				id: "request-1",
				name: "request-1",
				save: () => Promise.resolve("saved"),
				hasPendingChanges: true,
			});
			useSaveStore.getState().registerContext({
				id: "settings",
				name: "settings",
				save: () => Promise.resolve("pending"),
				hasPendingChanges: true,
			});
			registerOutcome("request-2", "disk-full");

			expect(await useSaveStore.getState().flushAll()).toEqual({
				saved: 1,
				failed: 1,
				pending: 1,
				reason: "disk-full",
			});
		});

		describe("a context whose save rejects", () => {
			const rejectWith = (id: string, error: Error) =>
				useSaveStore.getState().registerContext({
					id,
					name: id,
					save: () => Promise.reject(error),
					hasPendingChanges: true,
				});

			it("is disk-full when the engine answered 507", async () => {
				rejectWith(
					"request-1",
					new ApiError(
						507,
						"insufficient_storage",
						"The disk holding Vayu's data is full"
					)
				);

				await expect(useSaveStore.getState().flushAll()).resolves.toEqual({
					saved: 0,
					failed: 1,
					pending: 0,
					reason: "disk-full",
				});
			});

			it("names no cause for any other rejection", async () => {
				rejectWith("request-1", new ApiError(503, "unavailable", "busy"));

				const result = await useSaveStore.getState().flushAll();

				expect(result).toEqual({ saved: 0, failed: 1, pending: 0 });
				expect(result).not.toHaveProperty("reason");
			});
		});

		it("has no 'reason' key when nothing failed", async () => {
			registerContext("request-1", true);

			expect(await useSaveStore.getState().flushAll()).not.toHaveProperty("reason");
		});
	});

	it("counts a context that resolves 'pending' as pending, not saved", async () => {
		// A save the editor declined to send (`SaveBlockedError`) is neither a
		// success nor a failure, and the quit prompt must not call it either.
		useSaveStore.getState().registerContext({
			id: "request-1",
			name: "request-1",
			save: () => {
				useSaveStore.getState().markPendingSave();
				return Promise.resolve("pending");
			},
			hasPendingChanges: true,
		});

		await expect(useSaveStore.getState().flushAll()).resolves.toEqual({
			saved: 0,
			failed: 0,
			pending: 1,
		});
		expect(useSaveStore.getState().status).toBe("pending");
	});

	it("counts a context that reports nothing but published 'pending' as pending", async () => {
		useSaveStore.getState().registerContext({
			id: "settings",
			name: "settings",
			save: () => {
				useSaveStore.getState().markPendingSave();
				return Promise.resolve();
			},
			hasPendingChanges: true,
		});

		await expect(useSaveStore.getState().flushAll()).resolves.toEqual({
			saved: 0,
			failed: 0,
			pending: 1,
		});
	});

	it("gives each context its own verdict when two save in the same tick", async () => {
		// The status is one slot: the failing context publishes "error" while the
		// other is still resolving, and reading the slot back charged the failure
		// to both.
		useSaveStore.getState().registerContext({
			id: "request-1",
			name: "request-1",
			save: async () => {
				await Promise.resolve();
				return "saved";
			},
			hasPendingChanges: true,
		});
		useSaveStore.getState().registerContext({
			id: "settings",
			name: "settings",
			save: () => {
				useSaveStore.getState().failSave("engine down");
				return Promise.resolve("failed");
			},
			hasPendingChanges: true,
		});

		await expect(useSaveStore.getState().flushAll()).resolves.toEqual({
			saved: 1,
			failed: 1,
			pending: 0,
		});
		expect(useSaveStore.getState().status).toBe("error");
	});

	it("does not read one context's invented 'pending' as another's own", async () => {
		// Each success is held against the other, still-dirty context, so the
		// first to resolve leaves "pending" behind for the second to find.
		useSaveStore.getState().registerContext({
			id: "draft",
			name: "draft",
			save: () => Promise.resolve("saved"),
			hasPendingChanges: true,
		});
		registerContext("settings", true);

		await expect(useSaveStore.getState().flushAll()).resolves.toEqual({
			saved: 2,
			failed: 0,
			pending: 0,
		});
	});

	it("still counts a genuine 'pending' when a sibling void context saved first", async () => {
		registerContext("settings", true);
		useSaveStore.getState().registerContext({
			id: "variables",
			name: "variables",
			save: async () => {
				await Promise.resolve();
				useSaveStore.getState().markPendingSave();
			},
			hasPendingChanges: true,
		});

		await expect(useSaveStore.getState().flushAll()).resolves.toEqual({
			saved: 1,
			failed: 0,
			pending: 1,
		});
		expect(useSaveStore.getState().status).toBe("pending");
	});

	it("fills in 'saved' for a context that reports it but publishes nothing", async () => {
		useSaveStore.getState().registerContext({
			id: "draft",
			name: "draft",
			save: () => Promise.resolve("saved"),
			hasPendingChanges: true,
		});

		await useSaveStore.getState().flushAll();

		expect(useSaveStore.getState().status).toBe("saved");
	});
});
