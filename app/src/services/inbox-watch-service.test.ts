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
 * The inbox stream outlives the view that used to own it (issue #1400), and
 * still reconnects the way #506 made it (its budget, its resume point, its own
 * answer to a listener stopped elsewhere).
 *
 * Driven through the real notifier and the real query client rather than
 * stubbed ones: what is worth pinning is that a capture reaching this service
 * reaches the list and the notification with no view mounted anywhere, which a
 * spy on a seam inside the service would pass without proving.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { useClientSettingsStore, useInboxNotifyStore } from "@/stores";
import type { Inbox, InboxCapturesResponse } from "@/types";
import { INBOX_CAPTURE_NOTIFY_WINDOW_MS } from "@/modules/inbox/capture-notifier";
import {
	INBOX_LIVE_BACKGROUND_RESUME_MS,
	INBOX_LIVE_MAX_RETRIES,
	INBOX_LIVE_RETRY_BASE_MS,
	INBOX_LIVE_RETRY_MAX_MS,
	MAX_INBOX_WATCH_STREAMS,
	inboxLiveRetryDelayMs,
	inboxWatchService,
} from "./inbox-watch-service";

const listInboxes = vi.fn();

function record(overrides: Partial<Inbox> = {}): Inbox {
	return {
		inboxId: "inbox_a",
		url: "http://127.0.0.1:4100/",
		bind: "127.0.0.1",
		port: 4100,
		running: true,
		loopback: true,
		captureCount: 0,
		response: { status: 200, body: "", headers: {}, delayMs: 0 },
		...overrides,
	};
}

/** Every source the service opened, in order, with its callbacks reachable. */
class MockEventSource {
	static instances: MockEventSource[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;

	constructor(readonly url: string) {
		MockEventSource.instances.push(this);
	}

	close() {
		this.closed = true;
	}
}

function sources() {
	return MockEventSource.instances;
}

/** The sources still open, by the inbox their URL addresses. */
function openInboxIds(): string[] {
	return sources()
		.filter((s) => !s.closed)
		.map((s) => s.url.split("/inbox/")[1].split("/")[0]);
}

function latest() {
	const all = sources();
	expect(all.length).toBeGreaterThan(0);
	return all[all.length - 1];
}

function frame(id: number, overrides: Record<string, unknown> = {}) {
	return new MessageEvent("message", {
		lastEventId: String(id),
		data: JSON.stringify({
			id,
			inboxId: "inbox_a",
			method: "POST",
			path: "/hook",
			...overrides,
		}),
	});
}

/**
 * Put the engine's inbox list in the cache, the way the surfaces that observe
 * it do - with its query function attached, so the refetch behind
 * `listenerIsGone` reads the mock again rather than the seeded value.
 */
async function seedInboxList(inboxes: Inbox[]) {
	listInboxes.mockResolvedValue(inboxes);
	await queryClient.fetchQuery({
		queryKey: queryKeys.inbox.list(),
		queryFn: () => listInboxes() as Promise<Inbox[]>,
	});
}

/**
 * Fail the open stream and let its scheduled retry fire.
 *
 * Async because the reconnect is: before spending a retry the service asks the
 * engine whether the listener is still there (issue #554), so the timer is
 * scheduled a microtask after the error rather than inside it.
 */
async function dropAndWait(source = latest()) {
	source.onerror?.();
	await vi.advanceTimersByTimeAsync(INBOX_LIVE_RETRY_MAX_MS * 2);
}

/**
 * Fail every attempt the budget allows, leaving the stream given up on.
 *
 * The last refusal is failed here rather than through {@link dropAndWait},
 * whose wait would spend part of the cadence the give-up starts.
 */
async function spendTheLadder() {
	for (let attempt = 0; attempt < INBOX_LIVE_MAX_RETRIES; attempt++) await dropAndWait();
	latest().onerror?.();
}

const showNotification = vi.fn();

beforeEach(async () => {
	MockEventSource.instances = [];
	listInboxes.mockReset();
	showNotification.mockReset().mockResolvedValue("shown");
	vi.stubGlobal("EventSource", MockEventSource);
	vi.stubGlobal("electronAPI", { showNotification });
	vi.useFakeTimers();
	queryClient.clear();
	await seedInboxList([record()]);
	// Both notification gates start off, so only the cases that ask for one
	// (#1388) can post: every other case here drives the same stream.
	useClientSettingsStore.setState({ systemNotifications: false });
	useInboxNotifyStore.setState({ enabled: {} });
});

afterEach(() => {
	inboxWatchService.stopAll();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("inboxLiveRetryDelayMs", () => {
	it("clears the engine's default 250ms claim window on the first attempt", () => {
		// The app cannot read `inboxLivePollIntervalMs`, so the first step has to
		// outlast the default cadence on its own or the retry meets the same 409.
		expect(inboxLiveRetryDelayMs(1, () => 0)).toBeGreaterThan(250);
		expect(inboxLiveRetryDelayMs(1, () => 0)).toBe(INBOX_LIVE_RETRY_BASE_MS);
	});

	it("doubles up to the cap, and jitters within the step", () => {
		expect(inboxLiveRetryDelayMs(3, () => 0)).toBe(INBOX_LIVE_RETRY_BASE_MS * 4);
		expect(inboxLiveRetryDelayMs(20, () => 0)).toBe(INBOX_LIVE_RETRY_MAX_MS);
		// Jitter only ever adds, so a delay never drops back inside the window
		// the previous step was chosen to clear.
		const jittered = inboxLiveRetryDelayMs(1, () => 1);
		expect(jittered).toBeGreaterThan(INBOX_LIVE_RETRY_BASE_MS);
		expect(jittered).toBe(INBOX_LIVE_RETRY_BASE_MS * 1.5);
	});
});

describe("reconciling the streams a standing want asks for", () => {
	it("opens one for an inbox no view is showing", () => {
		// The fix, at its narrowest: nothing is mounted, and the inbox the user
		// asked to be notified about is watched anyway.
		// Mutation check: make `reconcile` skip inboxes with no holder and this
		// reddens.
		inboxWatchService.reconcile(["inbox_a"]);

		expect(openInboxIds()).toEqual(["inbox_a"]);
	});

	it("closes it when the want goes away", () => {
		inboxWatchService.reconcile(["inbox_a"]);
		const source = latest();

		inboxWatchService.reconcile([]);

		expect(source.closed).toBe(true);
		expect(openInboxIds()).toEqual([]);
	});

	it("shares one socket between the want and the view, and keeps it on unmount", () => {
		// The engine refuses a second stream per inbox with a 409, so a shared
		// socket is the contract rather than an optimisation.
		inboxWatchService.reconcile(["inbox_a"]);
		inboxWatchService.retain("inbox_a");
		expect(sources()).toHaveLength(1);

		inboxWatchService.release("inbox_a");

		expect(sources()).toHaveLength(1);
		expect(latest().closed).toBe(false);
	});

	it("closes the view's stream when the view is the only holder", () => {
		inboxWatchService.retain("inbox_a");
		const source = latest();

		inboxWatchService.release("inbox_a");

		expect(source.closed).toBe(true);
	});

	it("keeps the stream while a second holder remains", () => {
		// Two surfaces addressing the same inbox is one socket, not two, and the
		// first to leave does not take it with them.
		inboxWatchService.retain("inbox_a");
		inboxWatchService.retain("inbox_a");

		inboxWatchService.release("inbox_a");

		expect(sources()).toHaveLength(1);
		expect(latest().closed).toBe(false);
	});

	it("never exceeds the cap, and gives the view's inbox a slot", () => {
		const wanted = Array.from({ length: MAX_INBOX_WATCH_STREAMS + 3 }, (_, i) => `inbox_${i}`);
		inboxWatchService.reconcile(wanted);
		expect(openInboxIds()).toHaveLength(MAX_INBOX_WATCH_STREAMS);

		// The inbox on screen is the one whose captures are being read, so it
		// takes a slot from the tail rather than going unwatched.
		inboxWatchService.retain("inbox_on_screen");

		const open = openInboxIds();
		expect(open).toHaveLength(MAX_INBOX_WATCH_STREAMS);
		expect(open).toContain("inbox_on_screen");
	});
});

describe("what a capture reaches with no view mounted", () => {
	it("merges into the list the view will read, and notifies", () => {
		useClientSettingsStore.setState({ systemNotifications: true });
		useInboxNotifyStore.getState().setEnabled("inbox_a", true);
		inboxWatchService.reconcile(["inbox_a"]);

		latest().onmessage?.(frame(7));
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS);

		const cached = queryClient.getQueryData<InboxCapturesResponse>(
			queryKeys.inbox.captures("inbox_a")
		);
		expect(cached?.data.map((c) => c.id)).toEqual([7]);
		expect(showNotification).toHaveBeenCalledTimes(1);
		expect(showNotification.mock.calls[0][0]).toMatchObject({
			kind: "inbox-captured",
			body: "POST /hook",
			target: { view: "inbox", inboxId: "inbox_a" },
		});
	});

	it("drops the pending notification when the stream closes", () => {
		// A window still armed after the inbox stopped would speak for a stream
		// that no longer exists.
		useClientSettingsStore.setState({ systemNotifications: true });
		useInboxNotifyStore.getState().setEnabled("inbox_a", true);
		inboxWatchService.reconcile(["inbox_a"]);

		latest().onmessage?.(frame(4));
		inboxWatchService.reconcile([]);
		vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS * 2);

		expect(showNotification).not.toHaveBeenCalled();
	});

	it("ignores a frame that is not a capture", () => {
		inboxWatchService.reconcile(["inbox_a"]);

		latest().onmessage?.(new MessageEvent("message", { data: "{not json" }));
		latest().onmessage?.(new MessageEvent("message", { data: JSON.stringify({ id: "7" }) }));

		expect(
			queryClient.getQueryData<InboxCapturesResponse>(queryKeys.inbox.captures("inbox_a"))
		).toBeUndefined();
	});
});

describe("the stream's own reconnect", () => {
	it("reports open only while a source is open", () => {
		inboxWatchService.reconcile(["inbox_a"]);
		expect(inboxWatchService.getState("inbox_a")).toEqual({ watching: false, stopped: false });

		latest().onopen?.();

		expect(inboxWatchService.getState("inbox_a")).toEqual({ watching: true, stopped: false });
	});

	it("tells its subscribers, and stops when they leave", () => {
		const seen: boolean[] = [];
		inboxWatchService.reconcile(["inbox_a"]);
		const unsubscribe = inboxWatchService.subscribe("inbox_a", (s) => seen.push(s.watching));

		latest().onopen?.();
		unsubscribe();
		latest().onerror?.();

		// The state on subscribe, then the open - and nothing after the leave.
		expect(seen).toEqual([false, true]);
	});

	it("reconnects after a drop and resumes from the last capture it saw", async () => {
		inboxWatchService.reconcile(["inbox_a"]);
		latest().onopen?.();
		latest().onmessage?.(frame(12));
		const dropped = latest();

		await dropAndWait();

		// The dead source is closed rather than left to a browser retry that a
		// 409 has already made fatal, and a fresh one takes its place - carrying
		// the resume point as the query parameter the engine reads, since a
		// header is not settable on a fresh EventSource.
		expect(dropped.closed).toBe(true);
		expect(sources()).toHaveLength(2);
		expect(latest().url).toContain("lastEventId=12");
	});

	it("gives up after a bounded number of refusals, and resumes on request", async () => {
		inboxWatchService.reconcile(["inbox_a"]);

		// A persistent 409 never opens, so every attempt fails the same way.
		for (let attempt = 0; attempt <= INBOX_LIVE_MAX_RETRIES; attempt++) {
			await dropAndWait();
		}

		expect(sources()).toHaveLength(INBOX_LIVE_MAX_RETRIES + 1);
		expect(inboxWatchService.getState("inbox_a")).toEqual({ watching: false, stopped: true });

		// And it stays given up on for as long as the reconnect itself runs: no
		// further source appears on the ladder's own timescale. What happens a
		// minute later is the background resume, which is the last block's
		// subject and a different rate on purpose (#1403).
		vi.advanceTimersByTime(INBOX_LIVE_RETRY_MAX_MS * 4);
		expect(sources()).toHaveLength(INBOX_LIVE_MAX_RETRIES + 1);

		inboxWatchService.resume("inbox_a");
		expect(sources()).toHaveLength(INBOX_LIVE_MAX_RETRIES + 2);
		expect(inboxWatchService.getState("inbox_a").stopped).toBe(false);
	});

	it("cancels a scheduled retry when the stream is closed", async () => {
		inboxWatchService.reconcile(["inbox_a"]);
		latest().onerror?.();
		inboxWatchService.reconcile([]);
		const openedBeforeClose = sources().length;

		await vi.advanceTimersByTimeAsync(INBOX_LIVE_RETRY_MAX_MS * 10);

		expect(sources()).toHaveLength(openedBeforeClose);
	});

	it("spends no retry on a listener stopped from somewhere else", async () => {
		// A stop from the drawer, an MCP tool or curl ends the stream exactly the
		// way a dropped connection does, and only the engine can tell them apart
		// (issue #554).
		inboxWatchService.reconcile(["inbox_a"]);
		latest().onopen?.();
		listInboxes.mockResolvedValue([record({ running: false })]);

		await dropAndWait();

		expect(sources()).toHaveLength(1);
		expect(inboxWatchService.getState("inbox_a")).toEqual({ watching: false, stopped: false });
	});
});

describe("the fresh budget a background stream gets and a watched one does not", () => {
	it("resumes a stream nothing is watching after the cadence, and not before", async () => {
		// The failure #1403 is about: nothing renders a stream no tab is showing,
		// so the give-up that the inbox view would report with a Resume button
		// ended the toggle's promise for the rest of the session in silence.
		// Mutation check: drop the scheduling call and neither wait opens a socket.
		inboxWatchService.reconcile(["inbox_a"]);
		await spendTheLadder();
		expect(sources()).toHaveLength(INBOX_LIVE_MAX_RETRIES + 1);
		expect(inboxWatchService.getState("inbox_a")).toEqual({ watching: false, stopped: true });

		await vi.advanceTimersByTimeAsync(INBOX_LIVE_BACKGROUND_RESUME_MS - 1);
		expect(sources()).toHaveLength(INBOX_LIVE_MAX_RETRIES + 1);

		await vi.advanceTimersByTimeAsync(1);

		// One socket for the whole ladder plus one for the resume: the budget is
		// refilled, not exempted.
		expect(sources()).toHaveLength(INBOX_LIVE_MAX_RETRIES + 2);
		expect(latest().closed).toBe(false);
		expect(inboxWatchService.getState("inbox_a")).toEqual({ watching: false, stopped: false });
	});

	it("spends one ladder a cadence against an engine that keeps refusing", async () => {
		// The rate is the whole argument for resuming at all: a minute apart, a
		// resumed stream costs what one burst costs, not what an unbounded ladder
		// would. Mutation check: resume on a shorter clock and the counts move.
		inboxWatchService.reconcile(["inbox_a"]);
		await spendTheLadder();
		const oneLadder = sources().length;

		await vi.advanceTimersByTimeAsync(INBOX_LIVE_BACKGROUND_RESUME_MS);
		await spendTheLadder();
		expect(sources()).toHaveLength(oneLadder * 2);
		expect(inboxWatchService.getState("inbox_a").stopped).toBe(true);

		// And it keeps coming back: the give-up that ends the second ladder arms
		// the next resume exactly as the first did.
		await vi.advanceTimersByTimeAsync(INBOX_LIVE_BACKGROUND_RESUME_MS);
		expect(sources()).toHaveLength(oneLadder * 2 + 1);
	});

	it("notifies again on the resumed stream, which is the point of resuming", async () => {
		// The headline of #1403, end to end: the toggle keeps its promise after an
		// outage without the user opening the inbox tab. The notifier belongs to
		// the stream, so a resume that built a new one would have re-armed a
		// silent socket instead.
		useClientSettingsStore.setState({ systemNotifications: true });
		useInboxNotifyStore.getState().setEnabled("inbox_a", true);
		inboxWatchService.reconcile(["inbox_a"]);
		await spendTheLadder();

		await vi.advanceTimersByTimeAsync(INBOX_LIVE_BACKGROUND_RESUME_MS);
		latest().onopen?.();
		latest().onmessage?.(frame(9));
		await vi.advanceTimersByTimeAsync(INBOX_CAPTURE_NOTIFY_WINDOW_MS);

		expect(showNotification).toHaveBeenCalledTimes(1);
		expect(showNotification.mock.calls[0][0]).toMatchObject({
			kind: "inbox-captured",
			body: "POST /hook",
			target: { view: "inbox", inboxId: "inbox_a" },
		});
	});

	it("resumes from the last capture the spent stream saw", async () => {
		// What the stream missed while it was down is what the resume point is
		// for: the engine replays from it, so a capture is late rather than lost.
		inboxWatchService.reconcile(["inbox_a"]);
		latest().onopen?.();
		latest().onmessage?.(frame(31));
		await spendTheLadder();

		await vi.advanceTimersByTimeAsync(INBOX_LIVE_BACKGROUND_RESUME_MS);

		expect(latest().url).toContain("lastEventId=31");
	});

	it("arms nothing for a stream that is merely reconnecting", async () => {
		// Only a spent budget is resumed. A stream inside its ladder has a retry
		// of its own scheduled, and a second connect would race it.
		inboxWatchService.reconcile(["inbox_a"]);
		await dropAndWait();
		const reconnected = sources().length;
		latest().onopen?.();

		await vi.advanceTimersByTimeAsync(INBOX_LIVE_BACKGROUND_RESUME_MS * 2);

		expect(sources()).toHaveLength(reconnected);
	});

	it("leaves a stream the view is holding to the callout and the Resume", async () => {
		// A view renders the give-up and offers a Resume, so the user is told and
		// can act; a resume underneath it would be a callout that cleared itself.
		// Mutation check: drop the holder check and this reddens.
		inboxWatchService.retain("inbox_a");
		await spendTheLadder();
		const spent = sources().length;

		await vi.advanceTimersByTimeAsync(INBOX_LIVE_BACKGROUND_RESUME_MS * 3);

		expect(sources()).toHaveLength(spent);
		expect(inboxWatchService.getState("inbox_a")).toEqual({ watching: false, stopped: true });
	});

	it("takes that stream up once the view leaves", async () => {
		// The stream watched a moment ago is the background stream this exists
		// for: leaving the tab is what puts it there, and it must not need a
		// give-up of its own to qualify.
		inboxWatchService.reconcile(["inbox_a"]);
		inboxWatchService.retain("inbox_a");
		await spendTheLadder();
		const spent = sources().length;
		await vi.advanceTimersByTimeAsync(INBOX_LIVE_BACKGROUND_RESUME_MS * 2);
		expect(sources()).toHaveLength(spent);

		inboxWatchService.release("inbox_a");
		await vi.advanceTimersByTimeAsync(INBOX_LIVE_BACKGROUND_RESUME_MS);

		expect(sources()).toHaveLength(spent + 1);
	});

	it("does not resume a stream whose inbox is no longer wanted", async () => {
		// The want going away closes the stream, and a resume that read the
		// engine's list instead of the streams it actually holds would reopen an
		// inbox the user has just turned the toggle off for.
		inboxWatchService.reconcile(["inbox_a"]);
		await spendTheLadder();
		const spent = sources().length;

		inboxWatchService.reconcile([]);
		await vi.advanceTimersByTimeAsync(INBOX_LIVE_BACKGROUND_RESUME_MS * 2);

		expect(sources()).toHaveLength(spent);
	});
});

describe("what a surface listing every inbox reads", () => {
	it("names a wanted inbox the cap left out, and stops when a slot frees up", async () => {
		// `wantedInboxIds` slices the union to the cap and used to forget what it
		// dropped, so the ninth notify-enabled inbox was unwatched with nothing
		// anywhere able to say so (issue #1412).
		// Mutation check: slice without recording the remainder and this reddens.
		const wanted = Array.from({ length: MAX_INBOX_WATCH_STREAMS + 1 }, (_, i) => `inbox_${i}`);
		inboxWatchService.reconcile(wanted);

		expect(inboxWatchService.getSummary().unwatched).toEqual([
			`inbox_${MAX_INBOX_WATCH_STREAMS}`,
		]);

		inboxWatchService.reconcile(wanted.slice(1));

		expect(inboxWatchService.getSummary().unwatched).toEqual([]);
	});

	it("names a stream that gave up, and clears it on the connection that follows", async () => {
		inboxWatchService.reconcile(["inbox_a"]);
		expect(inboxWatchService.getSummary().stalled).toEqual([]);

		await spendTheLadder();
		expect(inboxWatchService.getSummary().stalled).toEqual(["inbox_a"]);

		// The resume alone is not the clear: a reconnect that is refused again
		// never stopped being silent, so the socket has to open.
		await vi.advanceTimersByTimeAsync(INBOX_LIVE_BACKGROUND_RESUME_MS);
		expect(inboxWatchService.getSummary().stalled).toEqual(["inbox_a"]);

		latest().onopen?.();

		expect(inboxWatchService.getSummary().stalled).toEqual([]);
	});

	it("answers with the same object until the answer changes", async () => {
		// The drawer reads this through `useSyncExternalStore`, which compares
		// snapshots by identity: a fresh object per call is an infinite render.
		const seen = vi.fn();
		const unsubscribe = inboxWatchService.subscribeSummary(seen);
		inboxWatchService.reconcile(["inbox_a"]);
		const before = inboxWatchService.getSummary();

		// A reconcile that changes nothing, and a capture: neither is news.
		inboxWatchService.reconcile(["inbox_a"]);
		latest().onopen?.();
		latest().onmessage?.(frame(2));
		expect(inboxWatchService.getSummary()).toBe(before);
		expect(seen).not.toHaveBeenCalled();

		await spendTheLadder();

		expect(inboxWatchService.getSummary()).not.toBe(before);
		expect(seen).toHaveBeenCalledTimes(1);

		unsubscribe();
		latest().onopen?.();
		expect(seen).toHaveBeenCalledTimes(1);
	});
});
