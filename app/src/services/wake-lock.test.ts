/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { wakeLock, WAKE_LOCK_KEYS } from "./wake-lock";

/** A deferred promise, so a case can control exactly when `holdWakeLock` answers. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (v: T) => void;
} {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Let every microtask queued so far (the module's own `.then`/`.catch`) run. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** Stub `window.electronAPI` with controllable `holdWakeLock` / `releaseWakeLock` mocks. */
function stubElectron(): {
	holdWakeLock: ReturnType<typeof vi.fn>;
	releaseWakeLock: ReturnType<typeof vi.fn>;
} {
	const holdWakeLock = vi.fn();
	const releaseWakeLock = vi.fn().mockResolvedValue(true);
	vi.stubGlobal("window", { electronAPI: { holdWakeLock, releaseWakeLock } });
	return { holdWakeLock, releaseWakeLock };
}

describe("wakeLock", () => {
	afterEach(async () => {
		// Each key is module-level state shared across cases - drain any
		// in-flight hold and hand it back so the next case starts on a clean key,
		// regardless of which branch the case under test exercised.
		await flushMicrotasks();
		wakeLock.release(WAKE_LOCK_KEYS.loadRun);
		await flushMicrotasks();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("takes one lock for two holds on the same key", () => {
		const { holdWakeLock } = stubElectron();
		holdWakeLock.mockResolvedValue("token-1");

		wakeLock.hold(WAKE_LOCK_KEYS.loadRun, "reason");
		// A second call for the same run (startMonitoring called again) must not
		// take a second lock while the first is still live. Reverting the
		// `holds.has(key)` guard in `hold()` makes this 2.
		wakeLock.hold(WAKE_LOCK_KEYS.loadRun, "reason");

		expect(holdWakeLock).toHaveBeenCalledTimes(1);
	});

	it("does nothing and never throws when releasing a key that is not held", () => {
		stubElectron();
		// Pins the `if (!state) return;` guard in `release()`.
		expect(() => wakeLock.release(WAKE_LOCK_KEYS.loadRun)).not.toThrow();
	});

	it("releases the token once it arrives when release() ran while the hold was still in flight", async () => {
		const { holdWakeLock, releaseWakeLock } = stubElectron();
		const pending = deferred<string>();
		holdWakeLock.mockReturnValue(pending.promise);

		wakeLock.hold(WAKE_LOCK_KEYS.loadRun, "reason");
		// The run ended before the main process ever answered.
		wakeLock.release(WAKE_LOCK_KEYS.loadRun);
		expect(releaseWakeLock).not.toHaveBeenCalled();

		pending.resolve("token-late");
		await flushMicrotasks();

		// Pins the `state.releasePending` branch in the `.then` handler: without
		// it the token that arrives after `release()` is stored and never handed
		// back, leaking the lock for the rest of the session.
		expect(releaseWakeLock).toHaveBeenCalledWith("token-late");
	});

	it("swallows a rejected hold, logs it, and leaves the key re-holdable", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { holdWakeLock } = stubElectron();
		holdWakeLock.mockRejectedValueOnce(new Error("main refused"));

		wakeLock.hold(WAKE_LOCK_KEYS.loadRun, "reason");
		await flushMicrotasks();

		// Pins the `console.warn` call in the `.catch` handler.
		expect(warn).toHaveBeenCalledTimes(1);

		// Pins `holds.delete(key)` in the `.catch` handler: without it the key
		// stays in the map forever and this second `hold()` is swallowed as a
		// duplicate of the failed one.
		holdWakeLock.mockResolvedValueOnce("token-2");
		wakeLock.hold(WAKE_LOCK_KEYS.loadRun, "reason");
		expect(holdWakeLock).toHaveBeenCalledTimes(2);
	});

	it("releasing after a rejected hold is still a safe no-op, never wedged", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { holdWakeLock } = stubElectron();
		holdWakeLock.mockRejectedValueOnce(new Error("main refused"));

		wakeLock.hold(WAKE_LOCK_KEYS.loadRun, "reason");
		await flushMicrotasks();

		expect(() => wakeLock.release(WAKE_LOCK_KEYS.loadRun)).not.toThrow();
	});

	it("is a no-op outside Electron - no window.electronAPI", () => {
		vi.stubGlobal("window", {});
		// Pins the `canHold()` guard: without it `hold()` calls into an
		// `electronAPI` that does not exist and throws.
		expect(() => wakeLock.hold(WAKE_LOCK_KEYS.loadRun, "reason")).not.toThrow();
		expect(() => wakeLock.release(WAKE_LOCK_KEYS.loadRun)).not.toThrow();
	});
});
