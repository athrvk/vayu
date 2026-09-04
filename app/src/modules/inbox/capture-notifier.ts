/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Telling the user a webhook arrived while they were elsewhere (issue #1388).
 *
 * Every other system notification the app posts is terminal and rare: a run
 * ends once, an update lands once, a sign-in completes once. A capture is
 * neither. The source sets the rate, and a source that retries can deliver
 * hundreds a minute, so this is the one event with two gates and a window:
 *
 * - The global opt-in, which `systemNotify.post` reads for every kind.
 * - This inbox's own toggle, read here, off by default even when the global
 *   one is on. A busy inbox cannot be made loud by the setting the user turned
 *   on for run results.
 * - A coalescing window, so a burst is one notification that says how many
 *   arrived rather than one notification each.
 *
 * The window is trailing rather than leading, which is the whole reason
 * `createThrottledBatcher` grew the option: committing the first capture at
 * once and the rest on the timer would post twice for one burst, and the issue
 * allows one. The cost is that a lone capture is announced a window late -
 * immaterial for a notification whose reader is by definition in another
 * application, and the price of "twenty captures produce one notification
 * saying twenty".
 *
 * The window is not a setting. It is a property of what an OS notification is
 * for, not of how fast this user's webhook source is, and #1358's rule was that
 * the shared notification settings say nothing about the inbox at all.
 */

import { createThrottledBatcher, type ThrottledBatcher } from "@/services/throttled-batcher";
import { NOTIFY_KINDS, systemNotify } from "@/services/notify";
import { inboxNotifiesOnCapture } from "@/stores";
import type { InboxCapture } from "@/types";

/**
 * How long one inbox's captures are gathered before a notification is posted.
 *
 * Ten seconds because the reader is in another window: the delay costs them
 * nothing, and a shorter window would split an ordinary retry storm across
 * several notifications, which is the noise the per-inbox toggle exists to
 * prevent in the first place.
 */
export const INBOX_CAPTURE_NOTIFY_WINDOW_MS = 10_000;

/** Gathers one inbox's captures and posts at most one notification per window. */
export interface CaptureNotifier {
	/** A capture arrived. Ignored unless this inbox's toggle is on. */
	record(capture: InboxCapture): void;
	/** Drop what is buffered and its pending post - the stream is over. */
	dispose(): void;
}

/** What one window of captures is announced as. */
export function captureNotification(batch: readonly InboxCapture[]): {
	title: string;
	body: string;
} {
	// The most recent capture, as the issue asks: a body naming the first of
	// twenty describes the moment the window opened, not the inbox's state now.
	const latest = batch[batch.length - 1];
	const where = `${latest.method} ${latest.path}`;
	if (batch.length === 1) {
		return { title: "Inbox received a request", body: where };
	}
	return {
		title: `Inbox received ${batch.length} requests`,
		body: `${batch.length} requests captured - latest ${where}`,
	};
}

/**
 * Watch one inbox.
 *
 * Per inbox rather than one notifier for all of them: the window is a rate
 * limit on how often *this* inbox may interrupt, and a shared one would let a
 * chatty inbox spend the quiet one's turn.
 */
export function createCaptureNotifier(inboxId: string): CaptureNotifier {
	const batcher: ThrottledBatcher<InboxCapture> = createThrottledBatcher<InboxCapture>(
		(batch) => {
			// Again at the post, not only at the capture: a toggle turned off
			// during the window silences the burst it was turned off for.
			if (!inboxNotifiesOnCapture(inboxId)) return;
			const { title, body } = captureNotification(batch);
			systemNotify.post({
				kind: NOTIFY_KINDS.inboxCaptured,
				title,
				body,
				// The inbox tab is where the capture landed, and it is the tab
				// that retargets, so a click lands on this inbox even when
				// another one is on screen.
				target: { view: "inbox", inboxId },
			});
		},
		{ leading: false, intervalMs: INBOX_CAPTURE_NOTIFY_WINDOW_MS }
	);

	return {
		record(capture: InboxCapture): void {
			// Read at the capture, not at subscribe time: captures recorded
			// while the toggle was off are not announced by turning it on.
			if (!inboxNotifiesOnCapture(inboxId)) return;
			batcher.push(capture);
		},
		dispose(): void {
			// Discarded rather than flushed. A stream ends because the user
			// switched inbox, closed the tab or quit - all of which happen in a
			// focused window, where a notification is suppressed anyway - or
			// because the toggle went off, the engine stopped the inbox, or the
			// stream cap evicted it, and none of those three is an inbox to
			// announce a capture for either.
			batcher.discard();
		},
	};
}
