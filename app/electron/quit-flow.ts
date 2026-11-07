/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one state machine a quit or a window close goes through before the
 * renderer is let go (#3335).
 *
 *     idle -> confirmingServices -> flushing -> confirmingLoss -> proceeding
 *
 * Each step can be skipped: nothing running skips the services question, a
 * clean flush skips the loss question. The services question comes first
 * because Cancel has to leave the renderer exactly as it was, and a flush has
 * already told it its work is ending. Cancel on the first question and Keep
 * working on the second are both edges back to `idle`, and `idle` forgets the
 * flush and the services answer together - the next gesture flushes again and
 * asks again. `quit-shutdown.ts` is the tail after `proceeding`: it stops the
 * engine and the MCP server once a quit is let through.
 *
 * Both gestures drive the same flow, so a quit that flushed and then closes the
 * window does not ask a dying renderer a second time, and an X that turns into
 * a quit (`window-all-closed` off macOS) asks nothing twice either.
 *
 * Every phase change bumps `ticket`, and every asynchronous answer - a dialog's
 * button, the renderer's ACK, the ceiling timer - acts only if the ticket is
 * still the one it was asked under. That is what drops an ACK from an earlier
 * flush, a ceiling that outlived its flush, and a dialog answered after a
 * renderer reload reset the flow. A flush's id is its ticket.
 *
 * Kept out of main.ts so it can be tested - main.ts creates windows and starts
 * the engine at import time, which no unit test can do.
 */

import {
	buildFlushFailurePrompt,
	FLUSH_TIMEOUT_MS,
	flushNeedsConfirmation,
	parseFlushResult,
	type FlushFailurePrompt,
	type FlushResult,
} from "./save-flush.js";
import type { IpcLike, StopGesture } from "./service-stop-guard.js";

/** Main asks the renderer to flush on this channel, carrying the flush's id. */
export const FLUSH_REQUEST_CHANNEL = "before-quit";
/** The renderer answers on this one, echoing the id beside its `FlushResult`. */
export const FLUSH_ACK_CHANNEL = "before-quit-flushed";

export type QuitPhase =
	"idle" | "confirmingServices" | "flushing" | "confirmingLoss" | "proceeding";

/** The slice of `ServiceStopGuard` the flow asks through. */
export interface ServicesQuestion {
	wouldStop: (gesture: StopGesture) => boolean;
	/** Resolves true for "anyway". Never rejects: an unaskable question is a no. */
	confirm: (gesture: StopGesture) => Promise<boolean>;
}

export interface QuitFlowDeps {
	services: ServicesQuestion;
	/**
	 * Ask the renderer to flush, tagged with `flushId`. Returns `false` when there
	 * is no live renderer to ask, in which case nothing it held can be saved and
	 * there is nothing to wait for.
	 */
	requestFlush: (flushId: number) => boolean;
	/** Arm the flush's ceiling. Never cancelled: a stale one is dropped by ticket. */
	schedule: (run: () => void, ms: number) => void;
	/**
	 * Run a held gesture's resume past the current turn (`setImmediate` in main),
	 * so `app.quit()` or `window.close()` is never re-entered from inside the
	 * handler that held it.
	 */
	defer: (run: () => void) => void;
	/** Put the loss question in front of the user; true is "proceed anyway". */
	askLoss: (prompt: FlushFailurePrompt) => Promise<boolean>;
	/** Where an unattended discard and an unaskable question are reported. */
	log: (msg: string, fields?: Record<string, unknown>) => void;
}

/** The slice of an Electron event this needs: the power to hold the gesture. */
export interface HoldableEvent {
	preventDefault: () => void;
}

export interface QuitFlow {
	/**
	 * Put a gesture through the flow. `true` lets it through now; `false` means
	 * it has been held, and `resume` repeats it if the flow reaches `proceeding`.
	 * Pass one stable `resume` per gesture source: the same function joining
	 * twice runs once, so a double Cmd-Q is one quit to resume.
	 */
	gesture: (gesture: StopGesture, event: HoldableEvent, resume: () => void) => boolean;
	/** The renderer's ACK. Dropped unless `flushId` is the flush in flight. */
	flushed: (flushId: unknown, result: FlushResult | null) => void;
	/**
	 * Back to `idle`, dropping whatever was held: the renderer that would have
	 * answered is gone (a crash recovered, a hung one reloaded, a new window).
	 */
	reset: () => void;
	/**
	 * Every quit from now on has nobody behind it - a signal or a session end.
	 * Sticky: such a quit asks nothing, and a question already on screen stops
	 * holding it. The window's own X always has someone behind it.
	 */
	markQuitUnattended: () => void;
	/** Where the flow is. Read by tests, not by main. */
	phase: () => QuitPhase;
}

/** What a flush with no renderer to ask reports: nothing it held could be saved. */
const NOTHING_TO_SAVE: FlushResult = { saved: 0, failed: 0, pending: 0 };

export function createQuitFlow(deps: QuitFlowDeps): QuitFlow {
	let phase: QuitPhase = "idle";
	let ticket = 0;
	/** The gesture the question on screen, or the flush in flight, speaks for. */
	let flowGesture: StopGesture = "quit";
	/** "Anyway" to the services question; forgotten with everything else on `idle`. */
	let servicesConfirmed = false;
	let unattendedQuit = false;
	/** What the flush reported, for an unattended quit that overrides the loss question. */
	let lossResult: FlushResult | null = null;
	/** Held gestures, in the order they arrived. */
	let held: Array<() => void> = [];

	const enter = (next: QuitPhase): number => {
		phase = next;
		return ++ticket;
	};

	const toIdle = () => {
		enter("idle");
		servicesConfirmed = false;
		lossResult = null;
		held = [];
	};

	const proceed = () => {
		enter("proceeding");
		const resumes = held;
		held = [];
		deps.defer(() => {
			for (const resume of resumes) resume();
		});
	};

	const servicesCleared = (g: StopGesture): boolean =>
		servicesConfirmed || (g === "quit" && unattendedQuit) || !deps.services.wouldStop(g);

	const askServices = (g: StopGesture, onYes: () => void) => {
		flowGesture = g;
		const asked = enter("confirmingServices");
		void deps.services.confirm(g).then((yes) => {
			if (asked !== ticket) return;
			if (!yes) return toIdle();
			servicesConfirmed = true;
			onYes();
		});
	};

	const startFlush = () => {
		const flushId = enter("flushing");
		deps.schedule(() => settleFlush(flushId, null), FLUSH_TIMEOUT_MS);
		if (!deps.requestFlush(flushId)) settleFlush(flushId, NOTHING_TO_SAVE);
	};

	const settleFlush = (flushId: unknown, result: FlushResult | null) => {
		if (phase !== "flushing" || flushId !== ticket) return;
		if (!flushNeedsConfirmation(result)) return proceed();
		if (flowGesture === "quit" && unattendedQuit) return discardUnattended(result);
		askLoss(result);
	};

	const askLoss = (result: FlushResult | null) => {
		lossResult = result;
		const asked = enter("confirmingLoss");
		deps.askLoss(buildFlushFailurePrompt(flowGesture, result))
			.catch((error: unknown) => {
				// Not consent: Keep working is the answer that discards nothing.
				deps.log("quit-flow: could not ask about a flush that did not land", {
					error: String(error),
				});
				return false;
			})
			.then((anyway) => {
				if (asked !== ticket) return;
				if (anyway) proceed();
				else toIdle();
			});
	};

	const discardUnattended = (result: FlushResult | null) => {
		deps.log("Quitting on a signal with a flush that did not land cleanly", { result });
		proceed();
	};

	/** An unattended quit takes over whatever the flow was waiting on a person for. */
	const takeOverForUnattendedQuit = () => {
		flowGesture = "quit";
		if (phase === "idle" || phase === "confirmingServices") startFlush();
		else if (phase === "confirmingLoss") discardUnattended(lossResult);
		// `flushing` needs nothing: its settle now sees an unattended quit.
	};

	const begin = (g: StopGesture) => {
		flowGesture = g;
		if (servicesCleared(g)) startFlush();
		else askServices(g, startFlush);
	};

	return {
		gesture: (g, event, resume) => {
			// A close is never asked twice: it is either the gesture that got here,
			// or the window going down under a quit that did.
			if (phase === "proceeding" && (g === "window-close" || servicesCleared(g))) {
				return true;
			}
			event.preventDefault();
			if (!held.includes(resume)) held.push(resume);
			if (g === "quit" && unattendedQuit) takeOverForUnattendedQuit();
			else if (phase === "idle") begin(g);
			// A quit joining a flow the services question did not cover - macOS's
			// close asks nothing, its quit does. The flush is already over.
			else if (phase === "proceeding") askServices(g, proceed);
			return false;
		},

		flushed: settleFlush,

		reset: toIdle,

		markQuitUnattended: () => {
			unattendedQuit = true;
		},

		phase: () => phase,
	};
}

/**
 * Wire the ACK channel. One listener for the life of the process: the id, not
 * a per-flush subscription, is what ties an ACK to its flush. A report main
 * cannot read still settles the flush, as `null`, which asks rather than
 * proceeding on a result nobody can vouch for.
 */
export function registerFlushAckIpc(
	ipc: IpcLike,
	flow: Pick<QuitFlow, "flushed">,
	log: (msg: string, fields?: Record<string, unknown>) => void
): void {
	ipc.on(FLUSH_ACK_CHANNEL, (_event, flushId, raw) => {
		const result = parseFlushResult(raw);
		if (!result) log("quit-flow: a flush ACK carried no readable result", { message: raw });
		flow.flushed(flushId, result);
	});
}
