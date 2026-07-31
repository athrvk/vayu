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
 * A save that reports "saved" must have saved the edits the caller had.
 *
 * `performSave` used to return immediately when another save was already in
 * flight. Every caller read that as success: Cmd+S, the quit flush and the
 * flush-on-entity-switch all awaited a no-op and got "saved" for edits that
 * were never in the flying snapshot. The switch case destroyed them outright,
 * because `RequestBuilderProvider` resets its state straight afterwards.
 *
 * Saves are queued now, so a caller's promise settles only once its own save
 * has run. These fail on a revert to the old skip: the queued `onSave` never
 * fires a second time, and the second caller resolves while the first request
 * is still in the air.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSaveManager } from "./useSaveManager";
import { useClientSettingsStore } from "@/stores";
import { useSaveStore, type SaveContext } from "@/stores/save-store";

/** A save the test can hold open, standing in for a slow engine write. */
function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function mountManager(onSave: () => Promise<void>) {
	return renderHook(() =>
		useSaveManager({ entityId: "req_1", contextName: "Request", onSave, hasChanges: true })
	);
}

/** Drain the microtask queue (no fake timers in the store suite below). */
async function tick() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Let queued promise callbacks run without advancing the clock meaningfully. */
async function settle() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
}

describe("a save arriving while another is in flight", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
		// Auto-save off isolates the explicit saves under test - and is also the
		// setting under which losing them is unbounded rather than capped by the
		// auto-save delay.
		useClientSettingsStore.setState({ autoSave: { enabled: false, delayMs: 5000 } });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("runs its own save instead of riding on the one already flying", async () => {
		const first = deferred();
		const second = deferred();
		const onSave = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { result } = mountManager(onSave);

		let secondSettled = false;
		act(() => {
			void result.current.forceSave();
		});
		await settle();
		expect(onSave).toHaveBeenCalledTimes(1);

		// Cmd+S while the first write is still in the air.
		act(() => {
			void result.current.forceSave().then(() => {
				secondSettled = true;
			});
		});
		expect(onSave).toHaveBeenCalledTimes(1); // queued behind the first
		expect(secondSettled).toBe(false);

		first.resolve();
		await settle();

		// The discriminating assertion. The old skip left this at 1 - the second
		// caller had been told "saved" without anything being sent.
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(secondSettled).toBe(false); // still waiting on its own write

		second.resolve();
		await settle();
		expect(secondSettled).toBe(true);
	});

	it("does not report 'saved' until the queued save has actually landed", async () => {
		const first = deferred();
		const second = deferred();
		const onSave = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { result } = mountManager(onSave);

		act(() => {
			void result.current.forceSave();
		});
		await settle();
		act(() => {
			void result.current.forceSave();
		});

		first.resolve();
		await settle();
		expect(useSaveStore.getState().status).toBe("saving"); // the queued one

		second.resolve();
		await settle();
		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("reports the failure when the queued save is the one that fails", async () => {
		const first = deferred();
		const second = deferred();
		const onSave = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { result } = mountManager(onSave);

		act(() => {
			void result.current.forceSave();
		});
		await settle();
		act(() => {
			void result.current.forceSave();
		});

		first.resolve();
		await settle();
		second.reject(new Error("database is locked"));
		await settle();

		// Never a false "saved": the first write succeeding does not make the
		// second one's edits safe.
		expect(useSaveStore.getState().status).toBe("error");
	});

	it("keeps the queue running after a failure rather than wedging it", async () => {
		const first = deferred();
		const onSave = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
		const { result } = mountManager(onSave);

		act(() => {
			void result.current.forceSave();
		});
		await settle();
		first.reject(new Error("offline"));
		await settle();
		expect(useSaveStore.getState().status).toBe("error");

		let retried = false;
		await act(async () => {
			await result.current.forceSave();
			retried = true;
		});
		expect(retried).toBe(true);
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(useSaveStore.getState().status).toBe("saved");
	});
});

/**
 * The other half of the false-"saved" seam, one layer up.
 *
 * `runSave` in the store wrapped `context.save()` and set "saved" whenever it
 * resolved. But every registered context reports its own failure through
 * `failSave` and then resolves rather than rejecting - `useSaveManager`,
 * `SettingsMain` and `VariableTableEditor` all do - so a failed Cmd+S ended up
 * displaying "Saved" beside its own failure toast.
 */
describe("the store's save trigger", () => {
	beforeEach(() => {
		useSaveStore.setState({ status: "idle", contexts: new Map(), activeContextId: null });
	});

	function registerContext(save: () => Promise<void>): SaveContext {
		const context: SaveContext = {
			id: "request-x",
			name: "Request",
			save,
			hasPendingChanges: true,
		};
		useSaveStore.getState().registerContext(context);
		useSaveStore.getState().setActiveContext("request-x");
		return context;
	}

	it("does not paint 'saved' over a failure the context already reported", async () => {
		registerContext(async () => {
			useSaveStore.getState().failSave("database is locked");
		});

		await useSaveStore.getState().triggerSave();

		expect(useSaveStore.getState().status).toBe("error");
	});

	it("still reports a genuine success", async () => {
		registerContext(async () => {});

		await useSaveStore.getState().triggerSave();

		expect(useSaveStore.getState().status).toBe("saved");
	});

	it("reports a context that rejects outright", async () => {
		registerContext(async () => {
			throw new Error("disk full");
		});

		await useSaveStore.getState().triggerSave();

		expect(useSaveStore.getState().status).toBe("error");
	});

	it("flushAll waits for every dirty context", async () => {
		const slow = deferred();
		useSaveStore.getState().registerContext({
			id: "settings",
			name: "Settings",
			save: () => slow.promise,
			hasPendingChanges: true,
		});

		let flushed = false;
		void useSaveStore
			.getState()
			.flushAll()
			.then(() => {
				flushed = true;
			});
		await tick();
		expect(flushed).toBe(false);

		slow.resolve();
		await tick();
		expect(flushed).toBe(true);
	});
});
