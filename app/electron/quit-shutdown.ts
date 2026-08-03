/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Stopping the engine and the MCP server exactly once on the way out.
 *
 * `before-quit`'s second pass defers the quit, stops both children, and quits
 * again when they are down. Its guard used to be "is the engine still running",
 * which is state that only clears *after* those awaits - so a second
 * `before-quit` arriving mid-shutdown started a second `stopMcp()`/`stopEngine()`
 * on top of the first. No extra user gesture is needed to get there: an X click
 * flushes and closes the window, `window-all-closed` fires `app.quit()`, and
 * that quit can land inside a shutdown a prior quit already began.
 *
 * So the guard has to be "has a shutdown started", which is three states rather
 * than two - a quit arriving *during* the shutdown must be deferred (letting it
 * through exits the app with the engine half-stopped, and an adopted engine
 * would survive as an orphan), while the quit the shutdown itself resumes must
 * fall straight through, or the app never exits at all.
 *
 * Kept out of main.ts so it can be tested - main.ts creates windows and starts
 * the engine at import time, which no unit test can do.
 */

/** The slice of main.ts this needs, so a test can pass a fake. */
export interface QuitShutdownTransport {
	/** Whether anything still needs stopping (engine, MCP server). */
	hasWork: () => boolean;
	/** Stop everything. Rejections are absorbed - a quit still has to finish. */
	stop: () => Promise<void>;
	/** Resume the quit once the children are down. */
	quit: () => void;
	/**
	 * Defer the resumed quit past the current turn (`setImmediate` in main), so
	 * `quit()` is not re-entered from inside the handler that stopped for it.
	 */
	defer: (run: () => void) => void;
}

export interface QuitShutdown {
	/**
	 * Handle a `before-quit` whose save flush has already settled. Prevents the
	 * default while there is still something to stop.
	 */
	handleQuit: (event: { preventDefault: () => void }) => void;
	/** Whether a shutdown has run to completion. Read by tests, not by main. */
	hasStopped: () => boolean;
}

export function createQuitShutdown(transport: QuitShutdownTransport): QuitShutdown {
	let state: "idle" | "stopping" | "stopped" = "idle";

	return {
		hasStopped: () => state === "stopped",

		handleQuit: (event) => {
			// The shutdown is over: this is either the quit it resumed, or a later
			// one. Either way there is nothing left to stop.
			if (state === "stopped") return;

			// A shutdown is in flight. Hold this quit - the one in flight resumes
			// it - rather than exiting on top of a half-stopped engine.
			if (state === "stopping") {
				event.preventDefault();
				return;
			}

			// Nothing to stop *yet* - the engine may still be coming up. Let this
			// quit through without latching, so a later one still finds work.
			if (!transport.hasWork()) return;

			state = "stopping";
			event.preventDefault();
			void (async () => {
				try {
					await transport.stop();
				} catch (error) {
					// A child that will not stop cannot hold the app open - and an
					// unhandled rejection here would take down the quit as well.
					console.error("[Main] Error during shutdown, quitting anyway:", error);
				} finally {
					// Marked before the resumed quit, so the `before-quit` it fires
					// falls through instead of deferring itself forever.
					state = "stopped";
					transport.defer(transport.quit);
				}
			})();
		},
	};
}
