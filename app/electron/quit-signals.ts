/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Signals that mean "stop", routed into Electron's own quit path.
 *
 * Node's default disposition for these is to terminate the process outright,
 * which skips `before-quit` in main.ts entirely - pending renderer saves are
 * never flushed, and the engine and MCP children are orphaned rather than shut
 * down. Every way Vayu is stopped from outside its own UI arrives as one of
 * these: the installer asking it to quit before replacing it on Linux (macOS
 * has an Apple Event for that, Linux has nothing but a signal), a Ctrl-C on a
 * development run, a session ending, systemd. All of them should land on the
 * same shutdown Cmd-Q takes.
 *
 * Kept out of main.ts so it can be tested: main.ts creates windows and starts
 * the engine at import time, which no unit test can do.
 */

export const QUIT_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

export type QuitSignal = (typeof QUIT_SIGNALS)[number];

/** The slice of `process` this needs, so a test can pass a fake. */
export interface SignalTarget {
	on(signal: QuitSignal, listener: () => void): unknown;
}

/**
 * Route every quit signal into `quit`, at most once.
 *
 * The guard matters because `before-quit` is asynchronous - it defers the quit
 * while the renderer flushes and the engine stops. A second signal arriving
 * during that window (an impatient second Ctrl-C, or a supervisor retrying)
 * would otherwise start a second shutdown on top of the one in flight.
 * SIGKILL remains the way to stop a genuinely stuck app; it cannot be trapped,
 * which is the point.
 */
export function installQuitOnSignal(target: SignalTarget, quit: () => void): void {
	let quitting = false;
	for (const signal of QUIT_SIGNALS) {
		target.on(signal, () => {
			if (quitting) return;
			quitting = true;
			quit();
		});
	}
}
