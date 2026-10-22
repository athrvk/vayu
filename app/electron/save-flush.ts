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

/**
 * What a settled flush actually did, so the window can stop deciding to close
 * on faith (#1489). `failed` is a save that was attempted and errored;
 * `pending` is one that settled without persisting its edit (a save the editor
 * declined to send, an edit that landed mid-flight). `null` from
 * `SaveFlusher.flush` (the 2s ceiling fired before the renderer answered) is
 * read the same as a result with either nonzero by `flushNeedsConfirmation`
 * below. `reason` names the cause when one explains every failure (#2423);
 * absent otherwise.
 */
export interface FlushResult {
	saved: number;
	failed: number;
	pending: number;
	reason?: "disk-full";
}

/** The slice of Electron this needs, so a test can pass a fake. */
export interface FlushTransport {
	/**
	 * Ask the renderer to flush its pending saves. Returns `false` when there is
	 * no live renderer to ask, in which case there is nothing to wait for.
	 */
	requestFlush: () => boolean;
	/** Subscribe to the renderer's one-shot ACK. Returns an unsubscribe function. */
	onFlushed: (listener: (result: FlushResult) => void) => () => void;
	/** Schedule the fallback timer. */
	schedule: (listener: () => void, ms: number) => void;
}

export interface SaveFlusher {
	/**
	 * Flush once, then run `done` with the outcome.
	 *
	 * - Nothing flushed yet: ask the renderer, and run `done` on its ACK or on
	 *   the ceiling, whichever lands first. A `null` result means the ceiling
	 *   won - the renderer never answered, so what it saved is unknown.
	 * - A flush in flight: join it. `done` runs when that one settles, not now -
	 *   the renderer's saves are still being written. Joining twice with the
	 *   same callback still runs it once: a repeated gesture (the second Cmd-Q
	 *   of an impatient double) is one thing to resume, not two.
	 * - Already settled: `done` runs immediately with the same result the first
	 *   caller got, the renderer has nothing left to write.
	 */
	flush: (done: (result: FlushResult | null) => void) => void;
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
	let waiting: Array<(result: FlushResult | null) => void> = [];
	/** What the flush that just settled reported, for a caller that joins late. */
	let lastResult: FlushResult | null = null;
	/**
	 * Bumped by every flush and every reset. The ceiling timer of a previous
	 * window's flush outlives that flush - without this it could settle the
	 * flush of the window that replaced it, seconds early.
	 */
	let generation = 0;

	const startFlush = () => {
		const startedAt = generation;
		let unsubscribe: (() => void) | null = null;

		const settle = (result: FlushResult | null) => {
			// The ACK and the ceiling race each other, and a superseded run's
			// timer may still fire: only the current run, still in flight, settles.
			if (startedAt !== generation || state !== "in-flight") return;
			state = "settled";
			lastResult = result;
			unsubscribe?.();
			const joined = waiting;
			waiting = [];
			for (const done of joined) done(result);
		};

		// Subscribe before asking, so an ACK that arrives synchronously (a
		// fake transport in a test, or a renderer with nothing to save) is
		// not missed.
		unsubscribe = transport.onFlushed((result) => settle(result));
		transport.schedule(() => settle(null), FLUSH_TIMEOUT_MS);
		// No renderer to ask means no edit of its could have survived it -
		// there is nothing to confirm, unlike a ceiling with nobody answering.
		if (!transport.requestFlush()) settle({ saved: 0, failed: 0, pending: 0 });
	};

	return {
		hasSettled: () => state === "settled",

		reset: () => {
			generation++;
			state = "idle";
			lastResult = null;
			// A new window's renderer cannot answer for the old one's saves, so
			// anything still waiting on the old flush is dropped with it.
			waiting = [];
		},

		flush: (done) => {
			if (state === "settled") {
				done(lastResult);
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

/** What a confirm dialog says, split the way Electron's message box takes it. */
export interface FlushFailurePrompt {
	message: string;
	detail: string;
	buttons: [proceed: string, keepWorking: string];
}

/** Whether a settled flush lost enough that discarding it needs asking about first. */
export function flushNeedsConfirmation(result: FlushResult | null): boolean {
	return result === null || result.failed > 0 || result.pending > 0;
}

/**
 * What to put in front of the user, phrased for `gesture`, when a flush did not
 * land cleanly. A failed save blames the engine; a save that merely stayed
 * pending does not, because nothing is wrong with the engine and "keep working
 * until it answers" would send the user to wait for something that is not
 * coming. A failure the renderer traced to a full disk says so instead, because
 * the engine is answering and waiting would not help either (#2423).
 */
export function buildFlushFailurePrompt(
	gesture: "quit" | "window-close",
	result: FlushResult | null
): FlushFailurePrompt {
	const verb = gesture === "quit" ? "Quit" : "Close";
	const lost = result === null ? null : result.failed + result.pending;
	const subject = lost === null ? "some edits" : lost === 1 ? "one edit" : `${lost} edits`;
	const pronoun = lost === 1 ? "it" : "them";
	const discards = `${verb === "Quit" ? "Quitting" : "Closing"} anyway discards ${pronoun}.`;
	const blockedOnly = result !== null && result.failed === 0;
	const buttons: FlushFailurePrompt["buttons"] = [`${verb} anyway`, "Keep working"];
	if (blockedOnly) {
		return {
			message: `${capitalize(subject)} couldn't be saved as ${lost === 1 ? "it is" : "they are"}.`,
			detail: `${discards} Keep working to finish ${pronoun}, then save again.`,
			buttons,
		};
	}
	// Checked after `blockedOnly`: a cause explains a failure, and there is none here.
	if (result?.reason === "disk-full") {
		return {
			message: `Couldn't save ${subject} - the disk is full.`,
			detail: `${discards} Free up space, then keep working to save again.`,
			buttons,
		};
	}
	return {
		message: `Couldn't save ${subject} - the engine isn't responding.`,
		detail: `${discards} Keep working to try again once the engine answers.`,
		buttons,
	};
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export interface FlushFailureGateDeps {
	/** Put the prompt in front of the user; true is "proceed anyway". */
	ask: (prompt: FlushFailurePrompt) => Promise<boolean>;
	/** Where an unattended quit records what it discarded instead of asking. */
	log: (msg: string, fields: Record<string, unknown>) => void;
}

export interface FlushFailureGate {
	/**
	 * Ask before discarding a flush that did not land cleanly; proceed silently
	 * when it did (#1489). An unattended quit proceeds either way and logs the
	 * result it discarded.
	 */
	confirm: (gesture: "quit" | "window-close", result: FlushResult | null) => Promise<boolean>;
	/**
	 * The next quit has nobody behind it - a signal, not a gesture. A dialog
	 * there waits for an answer that is never coming and the process is killed
	 * with its engine still running (#1908). Only the quit gesture is cleared:
	 * the window's own X always has someone behind it.
	 */
	markQuitUnattended: () => void;
}

/**
 * `ask` is injected so this is testable without Electron - `main.ts` wires it
 * to `dialog.showMessageBox` through the same `askOnWindow` helper the crash
 * and unresponsive-window prompts already use.
 */
export function createFlushFailureGate(deps: FlushFailureGateDeps): FlushFailureGate {
	let unattendedQuit = false;

	return {
		markQuitUnattended: () => {
			unattendedQuit = true;
		},

		confirm: async (gesture, result) => {
			if (!flushNeedsConfirmation(result)) return true;
			if (gesture === "quit" && unattendedQuit) {
				deps.log("Quitting on a signal with a flush that did not land cleanly", { result });
				return true;
			}
			return deps.ask(buildFlushFailurePrompt(gesture, result));
		},
	};
}
