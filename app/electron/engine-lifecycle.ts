/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The sidecar's lifecycle, carried to the window (#3336).
 *
 * Facts only: what the engine is doing and, for a crash, how it left. What the
 * Dock calls that is the renderer's to decide, and `engine:startFailure` stays
 * the one reason a start gives the user. Electron-free, so `main.ts` hands in
 * the send and the `ipcMain` slice.
 */

import type { EngineLifecycle } from "./sidecar.js";

export const ENGINE_LIFECYCLE_CHANNEL = "engine:lifecycle";

/**
 * The lifecycle as it crosses IPC: plain data, and a copy, so a listener never
 * holds the sidecar's own object. Mirrored in `preload.ts` and
 * `src/types/electron.d.ts`, which cannot import from here.
 */
export type EngineLifecyclePayload =
	| { kind: Exclude<EngineLifecycle["kind"], "crashed"> }
	| {
			kind: "crashed";
			code: number | null;
			signal: string | null;
			stderrTail: string[];
			error: string | null;
	  };

export function toEngineLifecyclePayload(lifecycle: EngineLifecycle): EngineLifecyclePayload {
	if (lifecycle.kind !== "crashed") return { kind: lifecycle.kind };
	const { code, signal, stderrTail, error } = lifecycle;
	return { kind: "crashed", code, signal, stderrTail: [...stderrTail], error };
}

/** The slice of `EngineSidecar` the bridge reads. */
export interface EngineLifecycleSource {
	getLifecycle(): EngineLifecycle;
	onLifecycle(listener: (lifecycle: EngineLifecycle) => void): () => void;
	onReadyAfterSlow(hook: () => void): () => void;
}

export interface EngineLifecycleBridge {
	/** To the live window, or nowhere; a window that loads later asks for the current state. */
	send: (channel: string, payload: EngineLifecyclePayload) => void;
	/** What the start that gave up on a slow engine would have done with a ready one. */
	readyAfterSlow: () => void;
}

/**
 * Push every transition to the window and run `readyAfterSlow` when a slow
 * engine answers. Call it before `start()`: the first transitions happen
 * inside it, and a hook attached after the start returned `slow` would race
 * the engine's answer.
 */
export function bridgeEngineLifecycle(
	source: EngineLifecycleSource,
	bridge: EngineLifecycleBridge
): void {
	source.onLifecycle((lifecycle) =>
		bridge.send(ENGINE_LIFECYCLE_CHANNEL, toEngineLifecyclePayload(lifecycle))
	);
	source.onReadyAfterSlow(bridge.readyAfterSlow);
}

/** The slice of `ipcMain` the channel needs. */
export interface IpcLike {
	handle(channel: string, listener: () => unknown): unknown;
}

/**
 * Answer the current lifecycle on request. A push sent before the renderer
 * loaded, or before a reload, reached nobody; this is how it catches up.
 */
export function registerEngineLifecycleIpc(ipc: IpcLike, current: () => EngineLifecycle): void {
	ipc.handle(ENGINE_LIFECYCLE_CHANNEL, () => toEngineLifecyclePayload(current()));
}
