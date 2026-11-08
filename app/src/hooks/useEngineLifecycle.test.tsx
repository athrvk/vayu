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
 * The sidecar's lifecycle, as the engine store holds it (#3336).
 *
 * The snapshot is the one reply that can be older than what the window already
 * knows, so the cases that matter are the two ways it goes stale: a push that
 * overtook it, and a restart that opened a new start window while it was out.
 *
 * A crash outlives the transient kinds (`idle`, `choosingPort`, `replacing`,
 * `spawning`) and ends only on `ready`, `slow`, `stopping` or `stopped`, so a
 * restart that fails before it spawns still leaves the Dock its Restart button.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEngineLifecycle } from "./useEngineLifecycle";
import { useEngineStore } from "@/stores";
import type { EngineLifecyclePayload } from "@/types/electron";

const CRASHED: EngineLifecyclePayload = {
	kind: "crashed",
	code: 139,
	signal: null,
	stderrTail: ["segfault"],
	error: null,
};

const CRASH_FACTS = { code: 139, signal: null, stderrTail: ["segfault"], error: null };

interface Bridge {
	push: (lifecycle: EngineLifecyclePayload) => void;
	answerSnapshot: (lifecycle: EngineLifecyclePayload) => Promise<void>;
	rejectSnapshot: () => Promise<void>;
	unsubscribe: ReturnType<typeof vi.fn>;
}

/** The preload bridge, with the snapshot held until the case releases it. */
function stubBridge(): Bridge {
	let listener: ((lifecycle: EngineLifecyclePayload) => void) | null = null;
	let settle: { resolve: (l: EngineLifecyclePayload) => void; reject: (e: Error) => void };
	const snapshot = new Promise<EngineLifecyclePayload>((resolve, reject) => {
		settle = { resolve, reject };
	});
	const unsubscribe = vi.fn();
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		getEngineLifecycle: vi.fn(() => snapshot),
		onEngineLifecycle: vi.fn((cb: (lifecycle: EngineLifecyclePayload) => void) => {
			listener = cb;
			return unsubscribe;
		}),
	};
	return {
		push: (lifecycle) => act(() => listener?.(lifecycle)),
		answerSnapshot: async (lifecycle) => {
			await act(async () => {
				settle.resolve(lifecycle);
				await snapshot;
			});
		},
		rejectSnapshot: async () => {
			await act(async () => {
				settle.reject(new Error("no handler"));
				await snapshot.catch(() => undefined);
			});
		},
		unsubscribe,
	};
}

beforeEach(() => {
	useEngineStore.setState({ engineCrash: null, engineStartWindow: 1000 });
});

afterEach(() => {
	delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("useEngineLifecycle", () => {
	it("reads the current lifecycle on mount", async () => {
		const bridge = stubBridge();
		renderHook(() => useEngineLifecycle());

		await bridge.answerSnapshot(CRASHED);

		expect(useEngineStore.getState().engineCrash).toEqual({
			code: 139,
			signal: null,
			stderrTail: ["segfault"],
			error: null,
		});
	});

	it("sets the crash on a pushed crashed", async () => {
		const bridge = stubBridge();
		renderHook(() => useEngineLifecycle());
		await bridge.answerSnapshot({ kind: "ready" });

		bridge.push(CRASHED);

		expect(useEngineStore.getState().engineCrash?.code).toBe(139);
	});

	// A restart from a crash walks these, and one that fails before a child
	// exists ends on idle: the Dock must still have its Restart button.
	it.each(["choosingPort", "replacing", "spawning", "idle"] as const)(
		"keeps the crash through %s",
		async (kind) => {
			const bridge = stubBridge();
			renderHook(() => useEngineLifecycle());
			await bridge.answerSnapshot({ kind: "ready" });
			bridge.push(CRASHED);

			bridge.push({ kind });

			expect(useEngineStore.getState().engineCrash?.code).toBe(139);
		}
	);

	it("keeps the crash through a restart that fails before it spawns", async () => {
		const bridge = stubBridge();
		renderHook(() => useEngineLifecycle());
		await bridge.answerSnapshot({ kind: "ready" });
		bridge.push(CRASHED);

		bridge.push({ kind: "replacing" });
		bridge.push({ kind: "choosingPort" });
		bridge.push({ kind: "idle" });

		expect(useEngineStore.getState().engineCrash?.code).toBe(139);
	});

	it.each(["ready", "slow", "stopping", "stopped"] as const)(
		"clears the crash on %s",
		async (kind) => {
			const bridge = stubBridge();
			renderHook(() => useEngineLifecycle());
			await bridge.answerSnapshot({ kind: "ready" });
			bridge.push(CRASHED);

			bridge.push({ kind });

			expect(useEngineStore.getState().engineCrash).toBeNull();
		}
	);

	it("keeps a crash that the snapshot reports through a restart's transient state", async () => {
		useEngineStore.setState({ engineCrash: CRASH_FACTS });
		const bridge = stubBridge();
		renderHook(() => useEngineLifecycle());

		await bridge.answerSnapshot({ kind: "idle" });

		expect(useEngineStore.getState().engineCrash).toEqual(CRASH_FACTS);
	});

	it("clears the crash when the snapshot reports an engine that is up", async () => {
		useEngineStore.setState({ engineCrash: CRASH_FACTS });
		const bridge = stubBridge();
		renderHook(() => useEngineLifecycle());

		await bridge.answerSnapshot({ kind: "ready" });

		expect(useEngineStore.getState().engineCrash).toBeNull();
	});

	it("carries a failure to run, which has an error and no exit code", async () => {
		const bridge = stubBridge();
		renderHook(() => useEngineLifecycle());
		await bridge.answerSnapshot({ kind: "ready" });

		bridge.push({
			kind: "crashed",
			code: null,
			signal: "SIGKILL",
			stderrTail: [],
			error: "spawn ENOENT",
		});

		expect(useEngineStore.getState().engineCrash).toEqual({
			code: null,
			signal: "SIGKILL",
			stderrTail: [],
			error: "spawn ENOENT",
		});
	});

	it("ignores a snapshot that a push overtook", async () => {
		const bridge = stubBridge();
		renderHook(() => useEngineLifecycle());

		// The engine crashed and was already replaced before the read answered.
		bridge.push({ kind: "spawning" });
		await bridge.answerSnapshot(CRASHED);

		expect(useEngineStore.getState().engineCrash).toBeNull();
	});

	it("ignores a snapshot about the crash a restart has since replaced", async () => {
		const bridge = stubBridge();
		renderHook(() => useEngineLifecycle());

		// Restart opens a new start window (useEngineRestart) before the read answers.
		act(() => useEngineStore.getState().openEngineStartWindow(2000));
		await bridge.answerSnapshot(CRASHED);

		expect(useEngineStore.getState().engineCrash).toBeNull();
	});

	it("unsubscribes on unmount, and a snapshot that answers later writes nothing", async () => {
		const bridge = stubBridge();
		const { unmount } = renderHook(() => useEngineLifecycle());

		unmount();
		expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);

		await bridge.answerSnapshot(CRASHED);
		expect(useEngineStore.getState().engineCrash).toBeNull();
	});

	it("survives a main process that cannot answer the read", async () => {
		const bridge = stubBridge();
		renderHook(() => useEngineLifecycle());

		await bridge.rejectSnapshot();
		bridge.push(CRASHED);

		expect(useEngineStore.getState().engineCrash?.code).toBe(139);
	});

	it("does nothing without the preload bridge", () => {
		expect(() => renderHook(() => useEngineLifecycle())).not.toThrow();
		expect(useEngineStore.getState().engineCrash).toBeNull();
	});
});
