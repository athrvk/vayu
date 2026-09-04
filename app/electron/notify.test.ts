/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The notifier's contract, in the terms the user feels: nothing while they are
 * looking at the window, nothing at all on a build that cannot show one, and a
 * click that brings the app back to what the notification was about (#1358).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createNotifier,
	readNotifyRequest,
	registerNotifyIpc,
	NOTIFY_ACTIVATED_CHANNEL,
	NOTIFY_AVAILABILITY_CHANNEL,
	NOTIFY_SHOW_CHANNEL,
	NOTIFY_UNAVAILABLE_REASON,
	type NotifyDeps,
	type NotifyRequest,
	type Notifier,
} from "./notify.js";

/** One built notification, with the two events Electron can fire on it. */
function fakeNotification() {
	const listeners = new Map<string, () => void>();
	return {
		shown: 0,
		on(event: "click" | "failed", listener: () => void) {
			listeners.set(event, listener);
			return this;
		},
		show() {
			this.shown++;
		},
		fire(event: "click" | "failed") {
			const listener = listeners.get(event);
			if (!listener) throw new Error(`nothing subscribed to ${event}`);
			listener();
		},
	};
}

interface HarnessOptions {
	supported?: boolean;
	focused?: boolean;
	hasWindow?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const built: ReturnType<typeof fakeNotification>[] = [];
	const state = {
		supported: options.supported ?? true,
		focused: options.focused ?? false,
		hasWindow: options.hasWindow ?? true,
	};
	const focus = vi.fn();
	const send = vi.fn();
	// Held rather than let through: `console.warn` here is the app's log in
	// production, and a test suite that prints it is one nobody reads.
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const deps: NotifyDeps = {
		create: () => {
			const notification = fakeNotification();
			built.push(notification);
			return notification;
		},
		isSupported: () => state.supported,
		isFocused: () => state.focused,
		hasWindow: () => state.hasWindow,
		focus,
		send,
	};
	return { built, state, focus, send, warn, notifier: createNotifier(deps) };
}

function request(patch: Partial<NotifyRequest> = {}): NotifyRequest {
	return {
		kind: "load-run-finished",
		title: "Load test finished",
		body: "12,400 requests, p95 210 ms, 0.3% errors",
		target: { view: "run", runId: "run_7" },
		...patch,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createNotifier - whether to post at all", () => {
	it("posts when the window is not the one the user is looking at", () => {
		const { notifier, built } = harness({ focused: false });

		expect(notifier.show(request())).toBe("shown");
		expect(built).toHaveLength(1);
		expect(built[0].shown).toBe(1);
	});

	it("says nothing while the window is focused - the toast already did", () => {
		const { notifier, built } = harness({ focused: true });

		// Pins the focus check in `show`. Drop it and a user watching the
		// dashboard is told twice about the same run.
		expect(notifier.show(request())).toBe("focused");
		expect(built).toHaveLength(0);
	});

	it("is a silent no-op where the platform supports no notifications", () => {
		const { notifier, built } = harness({ supported: false });

		expect(notifier.show(request())).toBe("unsupported");
		expect(built).toHaveLength(0);
	});

	it("says nothing when there is no window - the app is on its way out", () => {
		const { notifier, built } = harness({ hasWindow: false });

		expect(notifier.show(request())).toBe("no-window");
		expect(built).toHaveLength(0);
	});
});

describe("createNotifier - a click", () => {
	it("brings the window back and forwards what the notification was about", () => {
		const { notifier, built, focus, send } = harness();
		notifier.show(request());

		built[0].fire("click");

		expect(focus).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(NOTIFY_ACTIVATED_CHANNEL, {
			kind: "load-run-finished",
			target: { view: "run", runId: "run_7" },
		});
	});

	it("forwards a settings target as itself", () => {
		const { notifier, built, send } = harness();
		notifier.show(request({ kind: "update-ready", target: { view: "settings" } }));

		built[0].fire("click");

		expect(send).toHaveBeenCalledWith(NOTIFY_ACTIVATED_CHANNEL, {
			kind: "update-ready",
			target: { view: "settings" },
		});
	});
});

describe("createNotifier - a build that cannot show one", () => {
	it("latches on the first failure and stops trying", () => {
		const { notifier, built } = harness();
		notifier.show(request());

		// What an unsigned macOS build does under Electron 42+: no throw, a
		// `failed` event. Mutation check: drop the latch in the `failed` handler
		// and the second call answers "shown" again.
		built[0].fire("failed");

		expect(notifier.show(request())).toBe("unavailable");
		expect(built).toHaveLength(1);
	});

	it("reports the failure to the settings row, in the words it prints", () => {
		const { notifier, built } = harness();
		notifier.show(request());

		expect(notifier.availability()).toEqual({ available: true, reason: null });

		built[0].fire("failed");

		expect(notifier.availability()).toEqual({
			available: false,
			reason: NOTIFY_UNAVAILABLE_REASON,
		});
	});

	it("reports unavailable where the platform supports nothing, before any attempt", () => {
		const { notifier } = harness({ supported: false });

		expect(notifier.availability()).toEqual({
			available: false,
			reason: NOTIFY_UNAVAILABLE_REASON,
		});
	});

	it("logs the fallback once, however many failures arrive", () => {
		const { notifier, built, warn } = harness();
		notifier.show(request());

		built[0].fire("failed");
		built[0].fire("failed");

		expect(warn).toHaveBeenCalledTimes(1);
	});
});

describe("readNotifyRequest", () => {
	it("refuses a request with no title, at the line that sent it", () => {
		expect(() => readNotifyRequest({ kind: "k", body: "b" })).toThrow(TypeError);
		expect(() => readNotifyRequest({ kind: "", title: "t", body: "b" })).toThrow(TypeError);
		expect(() => readNotifyRequest(null)).toThrow(TypeError);
	});

	it("keeps a run target and falls back to the app for anything else", () => {
		expect(readNotifyRequest({ ...request() }).target).toEqual({
			view: "run",
			runId: "run_7",
		});
		// A run target with no id is not a run target: clicking it would open a
		// tab for the string "undefined".
		expect(readNotifyRequest({ ...request(), target: { view: "run" } }).target).toEqual({
			view: "app",
		});
		expect(readNotifyRequest({ ...request(), target: "elsewhere" }).target).toEqual({
			view: "app",
		});
	});
});

describe("registerNotifyIpc", () => {
	function fakeIpc() {
		const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
		return {
			handlers,
			handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) {
				handlers.set(channel, listener);
				return this;
			},
			call(channel: string, ...args: unknown[]) {
				const handler = handlers.get(channel);
				if (!handler) throw new Error(`no handler for ${channel}`);
				return handler({}, ...args);
			},
		};
	}

	function wired(): { ipc: ReturnType<typeof fakeIpc>; notifier: Notifier } {
		const { notifier } = harness();
		const ipc = fakeIpc();
		registerNotifyIpc(ipc, notifier);
		return { ipc, notifier };
	}

	it("wires both channels", () => {
		const { ipc } = wired();

		expect([...ipc.handlers.keys()]).toEqual([
			NOTIFY_SHOW_CHANNEL,
			NOTIFY_AVAILABILITY_CHANNEL,
		]);
	});

	it("answers a show with the outcome", () => {
		const { ipc } = wired();

		expect(ipc.call(NOTIFY_SHOW_CHANNEL, request())).toBe("shown");
	});

	it("rejects a malformed request rather than dropping it", () => {
		const { ipc } = wired();

		expect(() => ipc.call(NOTIFY_SHOW_CHANNEL, { kind: "k" })).toThrow(TypeError);
	});

	it("answers availability", () => {
		const { ipc } = wired();

		expect(ipc.call(NOTIFY_AVAILABILITY_CHANNEL)).toEqual({ available: true, reason: null });
	});
});
