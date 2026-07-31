/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What is actually at stake here is data, not tidiness: without these handlers
 * a signal kills the process outright and main.ts's `before-quit` never runs,
 * so the renderer's pending saves are dropped and the engine and MCP children
 * are orphaned. The installer on Linux has no Apple Event to ask politely with,
 * so a signal is the only way it can close Vayu before replacing it.
 */

import { describe, expect, it, vi } from "vitest";
import { installQuitOnSignal, QUIT_SIGNALS, type QuitSignal } from "./quit-signals.js";

/** Minimal stand-in for `process`: records handlers so a test can fire them. */
function fakeTarget() {
	const handlers = new Map<QuitSignal, () => void>();
	return {
		handlers,
		on(signal: QuitSignal, listener: () => void) {
			handlers.set(signal, listener);
			return this;
		},
	};
}

describe("installQuitOnSignal", () => {
	it("handles every signal a stop can arrive as", () => {
		const target = fakeTarget();
		installQuitOnSignal(target, vi.fn());
		expect([...target.handlers.keys()]).toEqual([...QUIT_SIGNALS]);
	});

	it.each(QUIT_SIGNALS)("quits on %s instead of dying where it stands", (signal) => {
		const quit = vi.fn();
		const target = fakeTarget();
		installQuitOnSignal(target, quit);
		target.handlers.get(signal)?.();
		expect(quit).toHaveBeenCalledTimes(1);
	});

	it("ignores a second signal while the first shutdown is in flight", () => {
		// before-quit defers the quit while the renderer flushes and the engine
		// stops. A second signal in that window - an impatient Ctrl-C, or a
		// supervisor retrying - must not start a competing shutdown.
		const quit = vi.fn();
		const target = fakeTarget();
		installQuitOnSignal(target, quit);
		target.handlers.get("SIGTERM")?.();
		target.handlers.get("SIGTERM")?.();
		target.handlers.get("SIGINT")?.();
		expect(quit).toHaveBeenCalledTimes(1);
	});
});
