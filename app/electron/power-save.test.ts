/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The wake lock's contract, in the terms a run depends on: one blocker however
 * many runs hold it, and none the moment the last one lets go. A ref count that
 * leaks pins the user's laptop awake for the session; one that drops early lets
 * the machine sleep mid-run, which is the bug #1357 exists to fix.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createWakeLock,
	registerPowerIpc,
	POWER_HOLD_CHANNEL,
	POWER_RELEASE_CHANNEL,
	POWER_RESUMED_CHANNEL,
	POWER_SUSPENDED_CHANNEL,
	WAKE_LOCK_BLOCKER_TYPE,
	type IpcEventLike,
	type WakeLock,
} from "./power-save.js";

function fakeBlocker() {
	const started = new Set<number>();
	let nextId = 1;
	return {
		started,
		startCalls: [] as string[],
		stopCalls: [] as number[],
		start(type: string) {
			this.startCalls.push(type);
			const id = nextId++;
			started.add(id);
			return id;
		},
		stop(id: number) {
			this.stopCalls.push(id);
			started.delete(id);
		},
		isStarted(id: number) {
			return started.has(id);
		},
	};
}

function fakeMonitor() {
	const listeners = new Map<string, () => void>();
	return {
		listeners,
		on(event: "suspend" | "resume", listener: () => void) {
			listeners.set(event, listener);
			return this;
		},
		fire(event: "suspend" | "resume") {
			const listener = listeners.get(event);
			if (!listener) throw new Error(`nothing subscribed to ${event}`);
			listener();
		},
	};
}

function harness(clock?: () => number) {
	const blocker = fakeBlocker();
	const monitor = fakeMonitor();
	const send = vi.fn();
	// Held rather than let through: these lines are the app's log in production
	// (see the eslint override for `electron/`), and a test suite that prints
	// them is a test suite nobody reads the output of.
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const lock = createWakeLock({ blocker, monitor, send, now: clock });
	return { blocker, monitor, send, lock, log };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createWakeLock - reference counting", () => {
	it("starts the blocker on the first hold, and only once", () => {
		const { blocker, lock } = harness();

		lock.hold("load run");
		lock.hold("collection run");

		expect(blocker.startCalls).toEqual([WAKE_LOCK_BLOCKER_TYPE]);
		expect(lock.activeHolds()).toBe(2);
	});

	it("says what is holding the machine awake, and when it lets go", () => {
		// The reason a holder gives has exactly one reader, and this is it: the
		// OS tools name Vayu but not what it is doing, so a reason that reached
		// nothing would be a string threaded through three layers for nobody.
		const { lock, log } = harness();
		const token = lock.hold("Load test run streaming");

		expect(log.mock.calls[0]?.[0]).toContain("Load test run streaming");

		log.mockClear();
		lock.release(token);
		expect(log).toHaveBeenCalledTimes(1);
	});

	it("keeps the blocker while another holder remains", () => {
		const { blocker, lock } = harness();
		const first = lock.hold("load run");
		lock.hold("collection run");

		expect(lock.release(first)).toBe(true);

		expect(blocker.stopCalls).toEqual([]);
		expect(blocker.started.size).toBe(1);
	});

	it("stops the blocker when the last holder lets go", () => {
		const { blocker, lock } = harness();
		const first = lock.hold("load run");
		const second = lock.hold("collection run");

		lock.release(first);
		lock.release(second);

		expect(blocker.stopCalls).toHaveLength(1);
		expect(blocker.started.size).toBe(0);
		expect(lock.activeHolds()).toBe(0);
	});

	it("ignores a token it never issued, and a second release of one it did", () => {
		const { blocker, lock } = harness();
		const token = lock.hold("load run");

		expect(lock.release("not-a-token")).toBe(false);
		expect(blocker.started.size).toBe(1);

		expect(lock.release(token)).toBe(true);
		expect(lock.release(token)).toBe(false);
		// The double release must not stop a blocker a later run started.
		expect(blocker.stopCalls).toHaveLength(1);
	});

	it("takes a fresh blocker for a run that starts after the last one ended", () => {
		const { blocker, lock } = harness();
		lock.release(lock.hold("load run"));

		lock.hold("second run");

		expect(blocker.startCalls).toEqual([WAKE_LOCK_BLOCKER_TYPE, WAKE_LOCK_BLOCKER_TYPE]);
		expect(blocker.started.size).toBe(1);
	});

	it("drops every hold a gone renderer took, and nobody else's", () => {
		const { blocker, lock } = harness();
		lock.hold("load run", 7);
		lock.hold("collection run", 7);
		lock.hold("run from another window", 9);

		expect(lock.releaseAllFrom(7)).toBe(2);

		expect(lock.activeHolds()).toBe(1);
		expect(blocker.stopCalls).toEqual([]);

		expect(lock.releaseAllFrom(9)).toBe(1);
		expect(blocker.stopCalls).toHaveLength(1);
	});

	it("does not stop a blocker for a renderer that held nothing", () => {
		const { blocker, lock } = harness();
		lock.hold("load run", 7);

		expect(lock.releaseAllFrom(9)).toBe(0);

		expect(blocker.stopCalls).toEqual([]);
	});
});

describe("createWakeLock - reporting a sleep it could not prevent", () => {
	it("says nothing about a suspend with no run under way", () => {
		const { monitor, send } = harness();

		monitor.fire("suspend");
		monitor.fire("resume");

		expect(send).not.toHaveBeenCalled();
	});

	it("reports the interval when the host slept during a run", () => {
		let now = 1_000;
		const { monitor, send, lock } = harness(() => now);
		lock.hold("load run");

		monitor.fire("suspend");
		now = 46_000;
		monitor.fire("resume");

		expect(send).toHaveBeenNthCalledWith(1, POWER_SUSPENDED_CHANNEL, { at: 1_000 });
		expect(send).toHaveBeenNthCalledWith(2, POWER_RESUMED_CHANNEL, {
			at: 46_000,
			durationMs: 45_000,
		});
	});

	it("closes an announced interval even though the run ended while the host was down", () => {
		let now = 1_000;
		const { monitor, send, lock } = harness(() => now);
		const token = lock.hold("load run");

		monitor.fire("suspend");
		lock.release(token);
		now = 5_000;
		monitor.fire("resume");

		expect(send).toHaveBeenLastCalledWith(POWER_RESUMED_CHANNEL, {
			at: 5_000,
			durationMs: 4_000,
		});
	});

	it("does not close an interval it never opened", () => {
		const { monitor, send, lock } = harness();
		// The host slept before the run; the run started after the resume.
		monitor.fire("suspend");
		lock.hold("load run");

		monitor.fire("resume");

		expect(send).not.toHaveBeenCalled();
	});
});

function fakeRenderer(id: number) {
	const once = new Map<string, () => void>();
	const on = new Map<string, () => void>();
	return {
		id,
		once(event: "destroyed", listener: () => void) {
			once.set(event, listener);
			return this;
		},
		on(event: "did-start-loading", listener: () => void) {
			on.set(event, listener);
			return this;
		},
		destroy() {
			once.get("destroyed")?.();
		},
		reload() {
			on.get("did-start-loading")?.();
		},
	};
}

function fakeIpc() {
	const handlers = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>();
	return {
		handlers,
		handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown) {
			handlers.set(channel, listener);
			return this;
		},
		call(channel: string, sender: IpcEventLike["sender"], ...args: unknown[]) {
			const handler = handlers.get(channel);
			if (!handler) throw new Error(`no handler for ${channel}`);
			return handler({ sender }, ...args);
		},
	};
}

function wired(): {
	ipc: ReturnType<typeof fakeIpc>;
	lock: WakeLock;
	blocker: ReturnType<typeof fakeBlocker>;
} {
	const { blocker, lock } = harness();
	const ipc = fakeIpc();
	registerPowerIpc(ipc, lock);
	return { ipc, lock, blocker };
}

describe("registerPowerIpc", () => {
	it("hands the renderer a token that releases its hold", () => {
		const { ipc, lock, blocker } = wired();
		const sender = fakeRenderer(1);

		const token = ipc.call(POWER_HOLD_CHANNEL, sender, "load run");
		expect(typeof token).toBe("string");
		expect(lock.activeHolds()).toBe(1);

		expect(ipc.call(POWER_RELEASE_CHANNEL, sender, token)).toBe(true);
		expect(blocker.started.size).toBe(0);
	});

	it("refuses a release that is not a token, without touching the lock", () => {
		const { ipc, lock } = wired();
		const sender = fakeRenderer(1);
		ipc.call(POWER_HOLD_CHANNEL, sender, "load run");

		expect(ipc.call(POWER_RELEASE_CHANNEL, sender, 42)).toBe(false);

		expect(lock.activeHolds()).toBe(1);
	});

	it("releases a destroyed renderer's holds", () => {
		const { ipc, lock, blocker } = wired();
		const sender = fakeRenderer(1);
		ipc.call(POWER_HOLD_CHANNEL, sender, "load run");

		sender.destroy();

		expect(lock.activeHolds()).toBe(0);
		expect(blocker.started.size).toBe(0);
	});

	it("releases holds a reloading renderer can no longer name", () => {
		const { ipc, lock, blocker } = wired();
		const sender = fakeRenderer(1);
		ipc.call(POWER_HOLD_CHANNEL, sender, "load run");

		sender.reload();

		expect(lock.activeHolds()).toBe(0);
		expect(blocker.started.size).toBe(0);
	});

	it("watches a renderer once however many holds it takes", () => {
		const { ipc, lock } = wired();
		const sender = fakeRenderer(1);
		const onSpy = vi.spyOn(sender, "on");

		ipc.call(POWER_HOLD_CHANNEL, sender, "load run");
		ipc.call(POWER_HOLD_CHANNEL, sender, "collection run");

		expect(onSpy).toHaveBeenCalledTimes(1);
		expect(lock.activeHolds()).toBe(2);
	});
});
