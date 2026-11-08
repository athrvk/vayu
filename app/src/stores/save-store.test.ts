/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Dock's `status` is derived from what every id reported about its own edit
 * (#3350), so no surface can clear another's failure and each failure is
 * published once, by whoever saw it fail.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { TIMING } from "@/config/timing";
import { ApiError } from "@/services/http-client";
import { resetSaveStoreForTests, useSaveStore, type SaveOutcome } from "./save-store";
import { useToastStore } from "./toast-store";

const store = () => useSaveStore.getState();
const status = () => store().status;
const toasts = () => useToastStore.getState().toasts;

const diskFull = () =>
	new ApiError(507, "insufficient_storage", "The disk holding Vayu's data is full");

/** A registered context, dirty or clean, whose `save` resolves with `save`'s result. */
function registerContext(
	id: string,
	hasPendingChanges: boolean,
	save: () => Promise<SaveOutcome | void> = () => Promise.resolve()
) {
	store().registerContext({ id, name: id, save, hasPendingChanges });
}

beforeEach(() => {
	resetSaveStoreForTests();
	useToastStore.setState({ toasts: [] });
});

describe("the derived status", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("follows one id from pending through saving to saved, then idle", () => {
		store().reportPending("a");
		expect(status()).toBe("pending");
		store().reportSaving("a");
		expect(status()).toBe("saving");
		store().reportSaved("a");
		expect(status()).toBe("saved");

		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS - 1);
		expect(status()).toBe("saved");
		vi.advanceTimersByTime(1);
		expect(status()).toBe("idle");
	});

	it("keeps a failure on one id through every kind of activity on another", () => {
		// Mutation check: deriving from the most recent report instead of from
		// every id turns this into "saved", then "idle".
		store().reportFailed("a", "Couldn't save - database is locked");

		for (const report of [
			() => store().reportPending("b"),
			() => store().reportSaving("b"),
			() => store().reportSaved("b"),
			() => store().discard("b"),
		]) {
			report();
			expect(status()).toBe("error");
			expect(store().lastErrorMessage).toBe("Couldn't save - database is locked");
		}

		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
		expect(status()).toBe("error");
	});

	it("ends the failure once that id saves", () => {
		store().reportFailed("a", "boom");
		store().reportSaved("a");

		expect(status()).toBe("saved");
		expect(store().lastErrorMessage).toBeNull();
	});

	it("ranks a failure over a save in flight over an unsent edit over a recent save", () => {
		store().reportSaved("d");
		store().reportPending("c");
		expect(status()).toBe("pending");
		store().reportSaving("b");
		expect(status()).toBe("saving");
		store().reportFailed("a", "boom");
		expect(status()).toBe("error");
	});

	it("describes the newest failure, and the older one once the newer is saved", () => {
		store().reportFailed("a", "first");
		store().reportFailed("b", "second");
		expect(store().lastErrorMessage).toBe("second");

		store().reportFailed("a", "first, again");
		expect(store().lastErrorMessage).toBe("first, again");

		store().reportSaved("a");
		expect(store().lastErrorMessage).toBe("second");
	});

	it("does not demote a failure to pending on a further edit, but a retry in flight does", () => {
		store().reportFailed("a", "boom");
		store().reportPending("a");
		expect(status()).toBe("error");

		store().reportSaving("a");
		expect(status()).toBe("saving");
	});

	it("shows saved only once no other id holds an edit", () => {
		store().reportPending("request-1");
		store().reportSaved("collection-tree-rename");
		expect(status()).toBe("pending");

		store().reportSaved("request-1");
		expect(status()).toBe("saved");
	});

	it("does not let an earlier save cut a later one's indicator short", () => {
		store().reportSaved("a");
		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS / 2);

		store().reportSaved("b");
		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS / 2);
		expect(status()).toBe("saved");

		vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS / 2);
		expect(status()).toBe("idle");
	});

	it("ends the saved indicator when an edit is made since, and does not bring it back on a discard", () => {
		store().reportSaved("a");
		store().reportPending("b");
		store().discard("b");

		expect(status()).toBe("idle");
	});

	it("keeps an id's report after it unregisters, until that id is settled", () => {
		registerContext("request-a", true);
		store().reportFailed("request-a", "boom");

		store().unregisterContext("request-a");
		expect(status()).toBe("error");

		store().discard("request-a");
		expect(status()).toBe("idle");
	});

	it("records on each failure whether it was the engine's 507", () => {
		store().reportFailed("a", "Couldn't save - full", diskFull());
		store().reportFailed("b", "Couldn't save - busy", new ApiError(503, "unavailable", "busy"));

		expect(store().unsaved.get("a")).toEqual({
			kind: "failed",
			message: "Couldn't save - full",
			diskFull: true,
		});
		expect(store().unsaved.get("b")).toMatchObject({ kind: "failed", diskFull: false });
	});

	it("raises one toast per reported failure", () => {
		store().reportFailed("a", "boom");

		expect(toasts()).toHaveLength(1);
		expect(toasts()[0]).toMatchObject({ message: "boom", variant: "error" });
	});
});

describe("discard", () => {
	it("withdraws an id's edit without claiming it saved", () => {
		store().reportPending("a");
		store().discard("a");

		expect(status()).toBe("idle");
	});

	it("withdraws a failure the discarded edit left", () => {
		store().reportFailed("a", "boom");
		store().discard("a");

		expect(status()).toBe("idle");
		expect(store().lastErrorMessage).toBeNull();
	});

	it("leaves another id's edit showing", () => {
		store().reportPending("a");
		store().reportPending("b");
		store().discard("a");

		expect(status()).toBe("pending");
	});
});

describe("runSave, through triggerSave", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const trigger = (id: string, save: () => Promise<SaveOutcome | void>) => {
		registerContext(id, true, save);
		store().setActiveContext(id);
		return store().triggerSave();
	};

	it("reports a silent success as saved", async () => {
		await trigger("settings", () => Promise.resolve());

		expect(status()).toBe("saved");
	});

	it("publishes a failure once when the context reported it and then rejected", async () => {
		// The variables editor's shape: it reports its own failure, worded its
		// own way, then rejects. The toast store folds identical messages into
		// one, so only differing wording shows the second toast. Mutation check:
		// dropping the "already reported" test in the rejection path raises it.
		await trigger("variables", () => {
			store().reportFailed("variables", "database is locked");
			return Promise.reject(new Error("database is locked"));
		});

		expect(toasts()).toHaveLength(1);
		expect(status()).toBe("error");
		expect(store().lastErrorMessage).toBe("database is locked");
	});

	it("publishes a rejection the context did not report", async () => {
		await trigger("settings", () => Promise.reject(new Error("offline")));

		expect(toasts()).toHaveLength(1);
		expect(store().lastErrorMessage).toBe("Couldn't save - offline");
	});

	it("publishes a rejection again when only an earlier save had reported a failure", async () => {
		store().reportFailed("settings", "Couldn't save - the first time");
		await trigger("settings", () => Promise.reject(new Error("the second time")));

		expect(toasts()).toHaveLength(2);
		expect(store().lastErrorMessage).toBe("Couldn't save - the second time");
	});

	it("leaves the publication of a returned failure verdict to the context", async () => {
		await trigger("inbox", () => {
			store().reportFailed("inbox", "Couldn't apply");
			return Promise.resolve("failed");
		});

		expect(toasts()).toHaveLength(1);
	});

	it("does not paint saved over a failure a silent context reported", async () => {
		await trigger("settings", () => {
			store().reportFailed("settings", "boom");
			return Promise.resolve();
		});

		expect(status()).toBe("error");
	});

	it("clears an earlier failure when the context saves cleanly this time", async () => {
		// The entity-switch flush's re-registered draft (#1489): its save is the
		// raw saver, which reports nothing, so the store's verdict is what clears
		// the failure that put it back in the registry.
		store().reportFailed("request-a", "Couldn't save - offline");
		await trigger("request-a", () => Promise.resolve());

		expect(status()).toBe("saved");
		expect(store().unsaved.has("request-a")).toBe(false);
	});
});

describe("flushAll", () => {
	it("reports nothing when nothing is dirty", async () => {
		registerContext("request-1", false);
		await expect(store().flushAll()).resolves.toEqual({ saved: 0, failed: 0, pending: 0 });
	});

	it("counts every dirty context that saved clean", async () => {
		registerContext("request-1", true);
		registerContext("settings", true);
		await expect(store().flushAll()).resolves.toEqual({ saved: 2, failed: 0, pending: 0 });
	});

	it("counts a rejecting save as failed, not saved", async () => {
		registerContext("request-1", true);
		registerContext("settings", true, () => Promise.reject(new Error("network error")));

		await expect(store().flushAll()).resolves.toEqual({ saved: 1, failed: 1, pending: 0 });
	});

	it("counts a context that resolves 'final' as failed, so the quit prompt still asks (#1889)", async () => {
		registerContext("request-1", true, () => {
			store().reportFailed("request-1", "Couldn't save - bad request");
			return Promise.resolve("final");
		});

		await expect(store().flushAll()).resolves.toEqual({ saved: 0, failed: 1, pending: 0 });
	});

	it("counts a context that resolves 'pending' as pending, not saved", async () => {
		// A save the editor declined to send (`SaveBlockedError`) is neither a
		// success nor a failure, and the quit prompt must not call it either.
		registerContext("request-1", true, () => Promise.resolve("pending"));

		await expect(store().flushAll()).resolves.toEqual({ saved: 0, failed: 0, pending: 1 });
		expect(status()).toBe("pending");
	});

	it("counts a silent context that reported pending as pending", async () => {
		registerContext("variables", true, async () => {
			await Promise.resolve();
			store().reportPending("variables");
		});
		registerContext("settings", true);

		await expect(store().flushAll()).resolves.toEqual({ saved: 1, failed: 0, pending: 1 });
		expect(status()).toBe("pending");
	});

	it("gives each context its own verdict when two save in the same tick", async () => {
		registerContext("request-1", true, async () => {
			await Promise.resolve();
			return "saved";
		});
		registerContext("settings", true, () => {
			store().reportFailed("settings", "engine down");
			return Promise.resolve();
		});

		await expect(store().flushAll()).resolves.toEqual({ saved: 1, failed: 1, pending: 0 });
		expect(status()).toBe("error");
	});

	it("fills in saved for a context that reports it but publishes nothing", async () => {
		registerContext("draft", true, () => Promise.resolve("saved"));
		store().reportPending("draft");

		await store().flushAll();

		expect(status()).toBe("saved");
	});

	describe("a draft the entity-switch flush put back after it failed (#1489)", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("is clean once a flush saves it, and the Dock goes back to idle", async () => {
			// Mutation check: judging the silent save by the earlier failure still
			// on the id (rather than by what it reported during this save) leaves
			// the Dock on "Not saved" here.
			store().reportFailed("request-a", "Couldn't save - offline");
			registerContext("request-a", true);

			await expect(store().flushAll()).resolves.toEqual({ saved: 1, failed: 0, pending: 0 });

			expect(status()).toBe("saved");
			vi.advanceTimersByTime(TIMING.SAVED_STATUS_DURATION_MS);
			expect(status()).toBe("idle");
		});
	});

	describe("naming the cause of a failure (#2423)", () => {
		const registerOutcome = (id: string, outcome: SaveOutcome) =>
			registerContext(id, true, () => {
				store().reportFailed(id, `Couldn't save ${id}`);
				return Promise.resolve(outcome);
			});

		it("carries 'disk-full' when it explains the only failure", async () => {
			registerOutcome("request-1", "disk-full");

			await expect(store().flushAll()).resolves.toEqual({
				saved: 0,
				failed: 1,
				pending: 0,
				reason: "disk-full",
			});
		});

		it("carries 'disk-full' when it explains every one of several failures", async () => {
			registerOutcome("request-1", "disk-full");
			registerOutcome("request-2", "disk-full");

			await expect(store().flushAll()).resolves.toEqual({
				saved: 0,
				failed: 2,
				pending: 0,
				reason: "disk-full",
			});
		});

		it("names no cause when another failure sits beside a disk-full one", async () => {
			registerOutcome("request-1", "disk-full");
			registerOutcome("request-2", "failed");

			const result = await store().flushAll();

			expect(result).toEqual({ saved: 0, failed: 2, pending: 0 });
			expect(result).not.toHaveProperty("reason");
		});

		it("names no cause for a disk-full failure beside a 'final' one", async () => {
			registerOutcome("request-1", "disk-full");
			registerOutcome("request-2", "final");

			expect(await store().flushAll()).not.toHaveProperty("reason");
		});

		it("keeps the cause when the failure sits beside a saved or pending context", async () => {
			registerContext("request-1", true, () => Promise.resolve("saved"));
			registerContext("settings", true, () => Promise.resolve("pending"));
			registerOutcome("request-2", "disk-full");

			expect(await store().flushAll()).toEqual({
				saved: 1,
				failed: 1,
				pending: 1,
				reason: "disk-full",
			});
		});

		it("is disk-full when a rejection is the engine's 507", async () => {
			// Mutation check: reading the cause from anything but the error the
			// save rejected with drops both the flag and the reason.
			registerContext("request-1", true, () => Promise.reject(diskFull()));

			await expect(store().flushAll()).resolves.toEqual({
				saved: 0,
				failed: 1,
				pending: 0,
				reason: "disk-full",
			});
			expect(store().unsaved.get("request-1")).toMatchObject({ diskFull: true });
		});

		it("names no cause for any other rejection", async () => {
			registerContext("request-1", true, () =>
				Promise.reject(new ApiError(503, "unavailable", "busy"))
			);

			const result = await store().flushAll();

			expect(result).toEqual({ saved: 0, failed: 1, pending: 0 });
			expect(result).not.toHaveProperty("reason");
			expect(store().unsaved.get("request-1")).toMatchObject({ diskFull: false });
		});

		it("is disk-full when a silent context reported the 507 as its cause (#2685)", async () => {
			registerContext("settings", true, () => {
				store().reportFailed("settings", "Couldn't save settings", diskFull());
				return Promise.resolve();
			});

			await expect(store().flushAll()).resolves.toEqual({
				saved: 0,
				failed: 1,
				pending: 0,
				reason: "disk-full",
			});
		});

		it("is failed, with no cause, when a silent context reported no cause", async () => {
			registerContext("settings", true, () => {
				store().reportFailed("settings", "Couldn't save settings");
				return Promise.resolve();
			});

			const result = await store().flushAll();

			expect(result).toEqual({ saved: 0, failed: 1, pending: 0 });
			expect(result).not.toHaveProperty("reason");
		});

		it("has no 'reason' key when nothing failed", async () => {
			registerContext("request-1", true);

			expect(await store().flushAll()).not.toHaveProperty("reason");
		});
	});
});
