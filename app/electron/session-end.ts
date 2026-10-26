/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Windows logoff and shutdown, routed into Electron's own quit path.
 *
 * Windows does not raise `before-quit` for a session ending; it raises
 * `query-session-end` on each window, then `session-end`, and the process is
 * gone as soon as the second handler returns (measured on Electron 44: a timer
 * started in `session-end` never fires). Nothing asynchronous can run there, so
 * the renderer's debounced autosave would be lost. `query-session-end` is the
 * last point that can still wait: preventing its default holds the session
 * open, and quitting from it takes the same flush and shutdown as Cmd-Q.
 * Windows ends the session once the process has exited.
 *
 * Kept out of main.ts so it can be tested, as quit-signals.ts is.
 */

/** The slice of `BrowserWindow` this needs, so a test can pass a fake. */
export interface SessionEndTarget {
	on(
		event: "query-session-end",
		listener: (event: { preventDefault: () => void }) => void
	): unknown;
}

/**
 * Hold the session open and quit when @p target is asked to end it, at most
 * once: a second query while the shutdown is in flight must not start another.
 */
export function installQuitOnSessionEnd(target: SessionEndTarget, quit: () => void): void {
	let quitting = false;
	target.on("query-session-end", (event) => {
		event.preventDefault();
		if (quitting) return;
		quitting = true;
		quit();
	});
}
