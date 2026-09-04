/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A capture may interrupt the user only through two gates and a window (#1388).
 *
 * Driven through the real `systemNotify` and the real stores rather than a
 * stubbed poster, because the thing worth pinning is that *both* gates are
 * consulted: a test that spies on `post` would pass with the global opt-in
 * ignored, which is the one mistake this feature cannot make.
 *
 * The mutation check for each case names the line that reverting would redden.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useClientSettingsStore, useInboxNotifyStore } from "@/stores";
import type { InboxCapture } from "@/types";
import { INBOX_CAPTURE_NOTIFY_WINDOW_MS, createCaptureNotifier } from "./capture-notifier";

const INBOX = "inbox_a";

const showNotification = vi.fn();

function capture(overrides: Partial<InboxCapture> = {}): InboxCapture {
	return {
		id: 1,
		inboxId: INBOX,
		receivedAt: 1_700_000_000_000,
		method: "POST",
		path: "/webhook",
		query: "",
		headers: {},
		body: "",
		bodyBytes: 0,
		bodyTruncated: false,
		remoteAddr: "127.0.0.1",
		...overrides,
	};
}

/** What the preload bridge would have carried, once the window elapses. */
function posted() {
	return showNotification.mock.calls.map(([request]) => request as Record<string, unknown>);
}

beforeEach(() => {
	vi.useFakeTimers();
	showNotification.mockReset().mockResolvedValue("shown");
	vi.stubGlobal("electronAPI", { showNotification });
	// Both gates start where the feature does: the global opt-in on, this
	// inbox's own toggle off.
	useClientSettingsStore.setState({ systemNotifications: true });
	useInboxNotifyStore.setState({ enabled: {} });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("createCaptureNotifier", () => {
	it("says nothing while this inbox's own toggle is off, with notifications on", () => {
		// Mutation check: drop either `inboxNotifiesOnCapture` read and this
		// posts, which is the whole reason the toggle exists.
		const notifier = createCaptureNotifier(INBOX);

		notifier.record(capture());
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS * 2);

		expect(showNotification).not.toHaveBeenCalled();
	});

	it("says nothing while system notifications are off, with the inbox's toggle on", () => {
		// Mutation check: the global opt-in read in `systemNotify.post`. A
		// capture must not be the one event that escapes it.
		useClientSettingsStore.setState({ systemNotifications: false });
		useInboxNotifyStore.getState().setEnabled(INBOX, true);
		const notifier = createCaptureNotifier(INBOX);

		notifier.record(capture());
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS * 2);

		expect(showNotification).not.toHaveBeenCalled();
	});

	it("posts one notification naming the method and path when both are on", () => {
		useInboxNotifyStore.getState().setEnabled(INBOX, true);
		const notifier = createCaptureNotifier(INBOX);

		notifier.record(capture({ method: "POST", path: "/webhook" }));
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS);

		expect(posted()).toEqual([
			{
				kind: "inbox-captured",
				title: "Inbox received a request",
				body: "POST /webhook",
				target: { view: "inbox", inboxId: INBOX },
			},
		]);
	});

	it("holds the post until the window elapses, so a burst is not two notifications", () => {
		// Mutation check: `leading: false` in the batcher options. A leading
		// edge would post here, and again for the rest of the burst.
		useInboxNotifyStore.getState().setEnabled(INBOX, true);
		const notifier = createCaptureNotifier(INBOX);

		notifier.record(capture());
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS - 1);
		expect(showNotification).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(showNotification).toHaveBeenCalledTimes(1);
	});

	it("answers twenty captures in one window with one notification saying twenty", () => {
		// Mutation check: remove the coalescing window and this posts twenty
		// times, which is what would teach a user to turn the feature off.
		useInboxNotifyStore.getState().setEnabled(INBOX, true);
		const notifier = createCaptureNotifier(INBOX);

		for (let i = 0; i < 20; i += 1) {
			notifier.record(capture({ id: i, method: "PUT", path: `/hook/${i}` }));
		}
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS);

		expect(posted()).toEqual([
			{
				kind: "inbox-captured",
				title: "Inbox received 20 requests",
				// The most recent, not the first: a body describing the moment the
				// window opened says nothing about the inbox now.
				body: "20 requests captured - latest PUT /hook/19",
				target: { view: "inbox", inboxId: INBOX },
			},
		]);
	});

	it("posts again for the next window, so a steady stream is not silenced after one", () => {
		useInboxNotifyStore.getState().setEnabled(INBOX, true);
		const notifier = createCaptureNotifier(INBOX);

		notifier.record(capture({ id: 1 }));
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS);
		notifier.record(capture({ id: 2, method: "GET", path: "/later" }));
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS);

		expect(posted()).toHaveLength(2);
		expect(posted()[1].body).toBe("GET /later");
	});

	it("silences a window the user turned the toggle off during", () => {
		// Mutation check: the second `inboxNotifiesOnCapture` read, in the
		// commit. Without it the burst the user just silenced still arrives.
		useInboxNotifyStore.getState().setEnabled(INBOX, true);
		const notifier = createCaptureNotifier(INBOX);

		notifier.record(capture());
		useInboxNotifyStore.getState().setEnabled(INBOX, false);
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS);

		expect(showNotification).not.toHaveBeenCalled();
	});

	it("does not announce captures that arrived while the toggle was off", () => {
		// Mutation check: the `inboxNotifiesOnCapture` read in `record`, which
		// the one in the commit cannot stand in for. Without it, turning the
		// toggle on mid-window announces what the user had chosen not to hear.
		const notifier = createCaptureNotifier(INBOX);

		notifier.record(capture());
		useInboxNotifyStore.getState().setEnabled(INBOX, true);
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS);

		expect(showNotification).not.toHaveBeenCalled();
	});

	it("drops a pending post when the stream it belonged to ends", () => {
		// Mutation check: `dispose` calling `discard`. A notifier left holding a
		// timer posts about an inbox the user has already switched away from.
		useInboxNotifyStore.getState().setEnabled(INBOX, true);
		const notifier = createCaptureNotifier(INBOX);

		notifier.record(capture());
		notifier.dispose();
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS * 2);

		expect(showNotification).not.toHaveBeenCalled();
	});

	it("keeps each inbox's window to itself", () => {
		// One notifier per subscription: a chatty inbox must not spend a quiet
		// one's turn, and a click must open the inbox the capture landed on.
		useInboxNotifyStore.getState().setEnabled(INBOX, true);
		useInboxNotifyStore.getState().setEnabled("inbox_b", true);
		const a = createCaptureNotifier(INBOX);
		const b = createCaptureNotifier("inbox_b");

		a.record(capture({ path: "/a" }));
		b.record(capture({ inboxId: "inbox_b", path: "/b" }));
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS);

		expect(posted().map((request) => request.target)).toEqual([
			{ view: "inbox", inboxId: INBOX },
			{ view: "inbox", inboxId: "inbox_b" },
		]);
	});
});
