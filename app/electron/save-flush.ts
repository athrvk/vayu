/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Flushing the renderer's pending saves before its window goes away.
 *
 * Two different events destroy the renderer and only one of them used to
 * flush. Cmd-Q, the menu and every quit signal arrive as `before-quit`, which
 * defers the quit and asks the renderer to flush. Clicking the window's X
 * arrives as `close`, which destroys the WebContents first: by the time
 * `window-all-closed` reaches `before-quit` the window handle is already null,
 * so the flush was skipped and everything inside the auto-save delay was lost.
 * On macOS it was worse - `close` does not quit at all, so the edits were gone
 * with the app still running and nothing to hint at it.
 *
 * Both paths route through one flusher, which is why "already flushed" is
 * shared state rather than a flag per path: a quit that flushed and then closes
 * the window must not flush again into a renderer that is already tearing down,
 * and an X that flushed must not make the quit that follows it wait a second
 * time.
 *
 * Kept out of main.ts so it can be tested - main.ts creates windows and starts
 * the engine at import time, which no unit test can do.
 */

/** How long to wait for the renderer's ACK before giving up and proceeding. */
export const FLUSH_TIMEOUT_MS = 2000;

/** The slice of Electron this needs, so a test can pass a fake. */
export interface FlushTransport {
	/**
	 * Ask the renderer to flush its pending saves. Returns `false` when there is
	 * no live renderer to ask, in which case there is nothing to wait for.
	 */
	requestFlush: () => boolean;
	/** Subscribe to the renderer's one-shot ACK. Returns an unsubscribe function. */
	onFlushed: (listener: () => void) => () => void;
	/** Schedule the fallback timer. */
	schedule: (listener: () => void, ms: number) => void;
}

export interface SaveFlusher {
	/**
	 * Flush once, then run `done`. If a flush already happened for this window,
	 * `done` runs immediately - the renderer has nothing left to write.
	 */
	flush: (done: () => void) => void;
	/** Whether this window's renderer has already been asked to flush. */
	hasFlushed: () => boolean;
	/** Forget the flush, for a freshly created window. */
	reset: () => void;
}

export function createSaveFlusher(transport: FlushTransport): SaveFlusher {
	let flushed = false;

	return {
		hasFlushed: () => flushed,

		reset: () => {
			flushed = false;
		},

		flush: (done) => {
			if (flushed) {
				done();
				return;
			}
			flushed = true;

			let settled = false;
			let unsubscribe: (() => void) | null = null;
			const settle = () => {
				if (settled) return;
				settled = true;
				unsubscribe?.();
				done();
			};

			// Subscribe before asking, so an ACK that arrives synchronously (a
			// fake transport in a test, or a renderer with nothing to save) is
			// not missed.
			unsubscribe = transport.onFlushed(settle);
			transport.schedule(settle, FLUSH_TIMEOUT_MS);
			if (!transport.requestFlush()) settle();
		},
	};
}
