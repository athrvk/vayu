/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a flush of the renderer's pending saves reports, and what the app says
 * when it did not land (#1489).
 *
 * Two different events destroy the renderer, and both must flush first. Cmd-Q,
 * the menu and every quit signal arrive as `before-quit`; the window's X
 * arrives as `close`, which destroys the WebContents before `window-all-closed`
 * can reach `before-quit` - and on macOS does not quit at all. The round trip
 * itself, and the one state machine both paths share, is `quit-flow.ts`.
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
 * declined to send, an edit that landed mid-flight). `null` (the 2s ceiling
 * fired before the renderer answered, or its report was unreadable) is read
 * the same as a result with either nonzero by `flushNeedsConfirmation`
 * below. `reason` names the cause when one explains every failure (#2423);
 * absent otherwise.
 */
export interface FlushResult {
	saved: number;
	failed: number;
	pending: number;
	reason?: "disk-full";
}

/**
 * Read the renderer's report off the ACK, or `null` for anything that is not
 * one. `null` is what an unanswered flush reports too, so a report main cannot
 * read is asked about rather than taken as clean.
 */
export function parseFlushResult(raw: unknown): FlushResult | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { saved, failed, pending, reason } = raw as Record<string, unknown>;
	if (!isCount(saved) || !isCount(failed) || !isCount(pending)) return null;
	return reason === "disk-full" ? { saved, failed, pending, reason } : { saved, failed, pending };
}

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;

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
		message: `Couldn't save ${subject} - Vayu's engine isn't responding.`,
		detail: `${discards} Keep working to try again once Vayu's engine answers.`,
		buttons,
	};
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
