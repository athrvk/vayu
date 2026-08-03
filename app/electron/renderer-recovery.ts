/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Getting the window back when its renderer process dies or stops answering.
 *
 * Electron does not recover a gone renderer. Nothing in the app listened for
 * `render-process-gone` or `unresponsive`, so a renderer that died - an OOM
 * from a huge response body being the realistic trigger for a load-testing tool
 * - left the BrowserWindow up, blank and frozen, with no reload, no dialog and
 * no diagnostics. The recovery story was "force-quit and relaunch, lose edits",
 * which is beneath the standard save-flush.ts sets for the ordinary close.
 *
 * A reload is the whole recovery, and it has to be bounded: a renderer that
 * crashes on the content it reloads crashes again on the same content, so an
 * unguarded reload is an infinite loop the user cannot get out of. Past two
 * crashes inside CRASH_WINDOW_MS the app stops trying and asks.
 *
 * The crash also matters to the *close* path. A dead renderer's WebContents
 * object outlives the process it drove, so `isDestroyed()` keeps reporting
 * false and the flusher would ask a renderer that can never ACK - burning the
 * full 2s ceiling on a window whose unsaved work is gone regardless. Hence
 * `isRendererGone`, which main.ts's flush transport reads to answer "there is
 * nobody to ask" straight away.
 *
 * Kept out of main.ts so it can be tested - main.ts creates windows and starts
 * the engine at import time, which no unit test can do.
 */

/** How far back a crash still counts toward the loop guard. */
export const CRASH_WINDOW_MS = 30_000;

/** Reloads allowed inside that window before the app stops trying. */
export const MAX_RELOADS_PER_WINDOW = 2;

/** What the process-gone details carry, without depending on Electron's types. */
export interface RendererGoneDetails {
	reason: string;
	exitCode: number;
}

/**
 * A renderer that exited with status zero was not lost, it was let go - the
 * window is being torn down. Reloading there fights the teardown and can bring
 * a window back up on the way out of the app.
 */
function isCrash(details: RendererGoneDetails): boolean {
	return details.reason !== "clean-exit";
}

export type CrashAction = "reload" | "prompt";

/**
 * Whether to reload again or stop and ask, given every crash seen so far
 * (including the one being handled) and the current time.
 *
 * Pure so the loop guard is testable without a window: the inline version of
 * this was the part that could silently become an infinite reload.
 */
export function decideCrashAction(crashTimes: readonly number[], now: number): CrashAction {
	const recent = crashTimes.filter((at) => now - at < CRASH_WINDOW_MS);
	return recent.length > MAX_RELOADS_PER_WINDOW ? "prompt" : "reload";
}

export type CrashLoopChoice = "relaunch" | "quit";
export type UnresponsiveChoice = "wait" | "reload";

/** The slice of Electron this needs, so a test can pass a fake. */
export interface RendererRecoveryTransport {
	now: () => number;
	/** Reload the current window's renderer in place - geometry is preserved. */
	reload: () => void;
	/** Crashes keep coming: ask whether to relaunch Vayu or give up and quit. */
	promptCrashLoop: (details: RendererGoneDetails) => Promise<CrashLoopChoice>;
	/** The renderer stopped answering: ask whether to keep waiting or reload. */
	promptUnresponsive: () => Promise<UnresponsiveChoice>;
	relaunch: () => void;
	quit: () => void;
	/**
	 * A live renderer has replaced a gone one. Whatever the dead one still owed
	 * is unrecoverable, so main.ts clears the save flush here - otherwise a
	 * flush that settled early against the corpse would let the *recovered*
	 * renderer's window close without ever being asked to save.
	 */
	onRecovered: () => void;
}

export interface RendererRecovery {
	/**
	 * Whether the renderer process is known to be gone. True from the crash
	 * until a renderer finishes loading again; read by the flush transport,
	 * which cannot tell from `webContents.isDestroyed()`.
	 */
	isRendererGone: () => boolean;
	/** `render-process-gone` on the window's webContents. */
	handleRenderProcessGone: (details: RendererGoneDetails) => void;
	/** A renderer finished loading - the reload worked, or a window is new. */
	noteRendererAlive: () => void;
	/** `unresponsive` on the window. */
	handleUnresponsive: () => void;
	/** `responsive` on the window. */
	handleResponsive: () => void;
}

export function createRendererRecovery(transport: RendererRecoveryTransport): RendererRecovery {
	/** When each crash happened, oldest first. Ages out via CRASH_WINDOW_MS. */
	const crashTimes: number[] = [];
	let gone = false;
	let promptOpen = false;
	let responding = true;

	return {
		isRendererGone: () => gone,

		handleRenderProcessGone: (details) => {
			console.error(
				`[Main] Renderer process gone: ${details.reason} (exit code ${details.exitCode})`
			);
			gone = true;
			// A hang cannot outlive the process that was hanging.
			responding = true;
			if (!isCrash(details)) return;

			const now = transport.now();
			crashTimes.push(now);
			if (decideCrashAction(crashTimes, now) === "reload") {
				transport.reload();
				return;
			}

			console.error("[Main] Renderer crash loop; asking the user what to do.");
			void transport.promptCrashLoop(details).then((choice) => {
				if (choice === "relaunch") transport.relaunch();
				else transport.quit();
			});
		},

		noteRendererAlive: () => {
			if (!gone) return;
			gone = false;
			transport.onRecovered();
		},

		handleUnresponsive: () => {
			responding = false;
			// One dialog, however long the hang lasts. Electron re-fires
			// `unresponsive` while the renderer stays stuck, and a stack of
			// identical modals is not more information.
			if (promptOpen) return;
			promptOpen = true;
			void transport.promptUnresponsive().then((choice) => {
				promptOpen = false;
				// There is no API to take a message box back down, so `responsive`
				// cannot close this one - it invalidates the answer instead.
				// Reloading a renderer that has since caught up would throw away
				// the user's work to fix a hang that is already over.
				if (responding) return;
				if (choice === "reload") transport.reload();
			});
		},

		handleResponsive: () => {
			responding = true;
		},
	};
}
