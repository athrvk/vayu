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
 * "Already flushed" is three states, not two. The round trip takes up to
 * FLUSH_TIMEOUT_MS, and a second gesture inside that window - an impatient
 * double Cmd-Q, or an X click on top of a quit - used to read "flush requested"
 * as "flush finished" and tear the renderer and the engine down while its saves
 * were still in flight, which is the very data loss the flusher exists to
 * prevent. So a caller arriving mid-flush joins the round trip already out and
 * runs when it settles; only a settled flush lets anyone straight through.
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
	 * Flush once, then run `done`.
	 *
	 * - Nothing flushed yet: ask the renderer, and run `done` on its ACK or on
	 *   the ceiling, whichever lands first.
	 * - A flush in flight: join it. `done` runs when that one settles, not now -
	 *   the renderer's saves are still being written. Joining twice with the
	 *   same callback still runs it once: a repeated gesture (the second Cmd-Q
	 *   of an impatient double) is one thing to resume, not two.
	 * - Already settled: `done` runs immediately, the renderer has nothing left
	 *   to write.
	 */
	flush: (done: () => void) => void;
	/**
	 * Whether this window's flush has finished - the renderer ACKed, or the
	 * ceiling expired. False both before a flush and during one, so a caller
	 * that gates the renderer's destruction on this cannot mistake a flush that
	 * is still in flight for one that is done.
	 */
	hasSettled: () => boolean;
	/** Forget the flush, for a freshly created window. */
	reset: () => void;
}

export function createSaveFlusher(transport: FlushTransport): SaveFlusher {
	let state: "idle" | "in-flight" | "settled" = "idle";
	/** Callbacks waiting on the flush in flight, in the order they joined. */
	let waiting: Array<() => void> = [];
	/**
	 * Bumped by every flush and every reset. The ceiling timer of a previous
	 * window's flush outlives that flush - without this it could settle the
	 * flush of the window that replaced it, seconds early.
	 */
	let generation = 0;

	const startFlush = () => {
		const startedAt = generation;
		let unsubscribe: (() => void) | null = null;

		const settle = () => {
			// The ACK and the ceiling race each other, and a superseded run's
			// timer may still fire: only the current run, still in flight, settles.
			if (startedAt !== generation || state !== "in-flight") return;
			state = "settled";
			unsubscribe?.();
			const joined = waiting;
			waiting = [];
			for (const done of joined) done();
		};

		// Subscribe before asking, so an ACK that arrives synchronously (a
		// fake transport in a test, or a renderer with nothing to save) is
		// not missed.
		unsubscribe = transport.onFlushed(settle);
		transport.schedule(settle, FLUSH_TIMEOUT_MS);
		if (!transport.requestFlush()) settle();
	};

	return {
		hasSettled: () => state === "settled",

		reset: () => {
			generation++;
			state = "idle";
			// A new window's renderer cannot answer for the old one's saves, so
			// anything still waiting on the old flush is dropped with it.
			waiting = [];
		},

		flush: (done) => {
			if (state === "settled") {
				done();
				return;
			}
			if (!waiting.includes(done)) waiting.push(done);
			if (state === "in-flight") return;
			state = "in-flight";
			generation++;
			startFlush();
		},
	};
}
