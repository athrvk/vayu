/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The window hears every lifecycle change the sidecar makes, and can ask for
 * the current one (#3336). The sidecar's own transitions are driven in
 * `sidecar.test.ts`; this holds the bridge from them to IPC, from main's side
 * and from the preload's.
 */

import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { transformWithOxc } from "vite";
import type { EngineLifecyclePayload as DeclaredPayload } from "../src/types/electron";
import {
	ENGINE_LIFECYCLE_CHANNEL,
	bridgeEngineLifecycle,
	registerEngineLifecycleIpc,
	toEngineLifecyclePayload,
	type EngineLifecyclePayload,
} from "./engine-lifecycle";
import type { EngineLifecycle } from "./sidecar";

const CRASH: Extract<EngineLifecycle, { kind: "crashed" }> = {
	kind: "crashed",
	code: null,
	signal: "SIGSEGV",
	stderrTail: ["database disk image is malformed"],
	error: null,
};

const EVERY_STATE: EngineLifecycle[] = [
	{ kind: "idle" },
	{ kind: "choosingPort" },
	{ kind: "replacing" },
	{ kind: "spawning" },
	{ kind: "ready" },
	{ kind: "slow" },
	CRASH,
	{ kind: "stopping" },
	{ kind: "stopped" },
];

/** Enough of `EngineSidecar` to publish a transition and fire the ready-after-slow hooks. */
function fakeSource(initial: EngineLifecycle = { kind: "idle" }) {
	let current = initial;
	const listeners = new Set<(lifecycle: EngineLifecycle) => void>();
	const hooks = new Set<() => void>();
	return {
		getLifecycle: () => current,
		onLifecycle(listener: (lifecycle: EngineLifecycle) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onReadyAfterSlow(hook: () => void) {
			hooks.add(hook);
			return () => hooks.delete(hook);
		},
		move(next: EngineLifecycle) {
			current = next;
			for (const listener of listeners) listener(next);
		},
		answerAfterSlow() {
			for (const hook of hooks) hook();
		},
	};
}

describe("the lifecycle payload", () => {
	it("is the kind alone for every state but a crash", () => {
		for (const state of EVERY_STATE.filter((s) => s.kind !== "crashed")) {
			expect(toEngineLifecyclePayload(state)).toEqual({ kind: state.kind });
		}
	});

	it("carries how a crashed engine left, as plain data", () => {
		const payload = toEngineLifecyclePayload(CRASH);

		expect(payload).toEqual(CRASH);
		// What IPC's structured clone would deliver.
		expect(structuredClone(payload)).toEqual(payload);
	});

	// Mutation check: return `lifecycle` itself for a crash and this reddens.
	it("is a copy, not the sidecar's own object", () => {
		const crash = { ...CRASH, stderrTail: [...CRASH.stderrTail] };
		const payload = toEngineLifecyclePayload(crash);

		crash.stderrTail.push("a later line");

		expect(payload).not.toBe(crash);
		expect(payload).toMatchObject({ stderrTail: ["database disk image is malformed"] });
	});

	it("is the shape the renderer is told it receives", () => {
		expectTypeOf<EngineLifecyclePayload>().toEqualTypeOf<DeclaredPayload>();
	});
});

describe("bridgeEngineLifecycle", () => {
	// Mutation check: drop the `onLifecycle` subscription and nothing is sent.
	it("sends every transition to the window, in order", () => {
		const source = fakeSource();
		const send = vi.fn();
		bridgeEngineLifecycle(source, { send, readyAfterSlow: vi.fn() });

		for (const state of EVERY_STATE) source.move(state);

		expect(send.mock.calls).toEqual(
			EVERY_STATE.map((state) => [ENGINE_LIFECYCLE_CHANNEL, toEngineLifecyclePayload(state)])
		);
	});

	// Mutation check: drop the `onReadyAfterSlow` subscription and the hook
	// never runs.
	it("runs readyAfterSlow when a slow engine answers, and not on a transition alone", () => {
		const source = fakeSource();
		const readyAfterSlow = vi.fn();
		bridgeEngineLifecycle(source, { send: vi.fn(), readyAfterSlow });

		source.move({ kind: "ready" });
		expect(readyAfterSlow).not.toHaveBeenCalled();

		source.answerAfterSlow();
		expect(readyAfterSlow).toHaveBeenCalledOnce();
	});
});

describe("registerEngineLifecycleIpc", () => {
	function registered(current: () => EngineLifecycle) {
		const handle = vi.fn();
		registerEngineLifecycleIpc({ handle }, current);
		expect(handle).toHaveBeenCalledOnce();
		const [channel, listener] = handle.mock.calls[0] as [string, () => unknown];
		return { channel, listener };
	}

	// Mutation check: capture `current()` once at registration and the second
	// answer is still `spawning`.
	it("answers the lifecycle as it is when asked, for a window that loaded late", () => {
		const source = fakeSource({ kind: "spawning" });
		const { channel, listener } = registered(source.getLifecycle);

		expect(channel).toBe(ENGINE_LIFECYCLE_CHANNEL);
		expect(listener()).toEqual({ kind: "spawning" });

		source.move(CRASH);
		expect(listener()).toEqual(CRASH);
	});
});

describe("the preload's half", () => {
	const preload = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");

	interface LifecycleApi {
		onEngineLifecycle: (callback: (lifecycle: unknown) => void) => () => void;
		getEngineLifecycle: () => Promise<unknown>;
	}

	/** Run the real preload against a fake `electron`, as `preload-grant-channel.test.ts` does. */
	async function runPreload() {
		const { code } = await transformWithOxc(preload, "preload.ts", { lang: "ts" });
		let api: LifecycleApi | undefined;
		const ipcRenderer = {
			send: vi.fn(),
			sendSync: vi.fn(),
			invoke: vi.fn(async () => ({ kind: "ready" })),
			on: vi.fn(),
			removeListener: vi.fn(),
		};
		const electron = {
			contextBridge: {
				exposeInMainWorld: (_name: string, value: LifecycleApi) => {
					api = value;
				},
			},
			ipcRenderer,
			webFrame: {},
			webUtils: {},
		};
		new Function("require", "process", "window", code)(
			() => electron,
			{ argv: [], platform: "linux" },
			{ addEventListener: () => {} }
		);
		if (!api) throw new Error("the preload exposed nothing");
		return { api, ipcRenderer };
	}

	it("spells the channel the way main does", () => {
		// The preload is CommonJS and cannot import the constant.
		expect(preload.length).toBeGreaterThan(10_000);
		expect(preload).toContain(`ipcRenderer.on("${ENGINE_LIFECYCLE_CHANNEL}", handler)`);
		expect(preload).toContain(`ipcRenderer.invoke("${ENGINE_LIFECYCLE_CHANNEL}")`);
	});

	// Mutation check: forward the event object instead of the payload, or
	// remove a different function than the one added, and this reddens.
	it("hands each push to the callback, and the unsubscribe removes that listener", async () => {
		const { api, ipcRenderer } = await runPreload();
		const callback = vi.fn();

		const unsubscribe = api.onEngineLifecycle(callback);
		const call = ipcRenderer.on.mock.calls.find(
			([channel]) => channel === ENGINE_LIFECYCLE_CHANNEL
		);
		if (!call) throw new Error("the preload never listened for the lifecycle");
		const handler = call[1] as (event: unknown, payload: unknown) => void;
		handler({ sender: "main" }, CRASH);
		unsubscribe();

		expect(callback.mock.calls).toEqual([[CRASH]]);
		expect(ipcRenderer.removeListener).toHaveBeenCalledWith(ENGINE_LIFECYCLE_CHANNEL, handler);
	});

	it("asks main for the current lifecycle", async () => {
		const { api, ipcRenderer } = await runPreload();

		await expect(api.getEngineLifecycle()).resolves.toEqual({ kind: "ready" });
		expect(ipcRenderer.invoke).toHaveBeenCalledWith(ENGINE_LIFECYCLE_CHANNEL);
	});
});
