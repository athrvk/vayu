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
 * The inbox live stream owns its reconnect (issue #506).
 *
 * `EventSource` treats a non-200 as fatal and never retries it, and a reconnect
 * landing inside the engine's dead-socket detection window meets a 409 from the
 * previous stream's claim - so a single unlucky disconnect used to end the
 * stream for the life of the tab with nothing said. These pin both halves of the
 * fix: the stream comes back on its own, and when it cannot, it says so instead
 * of leaving the badge on `Running`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { queryKeys, useInboxesQuery } from "@/queries";
import type { Inbox, InboxCapturesResponse } from "@/types";
import {
	INBOX_LIVE_MAX_RETRIES,
	INBOX_LIVE_RETRY_BASE_MS,
	INBOX_LIVE_RETRY_MAX_MS,
	inboxLiveRetryDelayMs,
	useInboxLive,
} from "./useInboxLive";

const listInboxes = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: { ...actual.apiService, listInboxes: () => listInboxes() },
	};
});

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

/** Every source the hook opened, in order, with its callbacks reachable. */
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

function latest() {
	const all = sources();
	expect(all.length).toBeGreaterThan(0);
	return all[all.length - 1];
}

function makeClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

/**
 * Fail the open stream and let its scheduled retry fire.
 *
 * Async because the reconnect is: before spending a retry the hook asks the
 * engine whether the listener is still there (issue #554), so the timer is
 * scheduled a microtask after the error rather than inside it.
 */
async function dropAndWait() {
	await act(async () => void latest().onerror?.());
	await act(async () => void vi.advanceTimersByTime(INBOX_LIVE_RETRY_MAX_MS * 2));
}

beforeEach(() => {
	MockEventSource.instances = [];
	listInboxes.mockReset().mockResolvedValue([record()]);
	vi.stubGlobal("EventSource", MockEventSource);
	vi.useFakeTimers();
});

afterEach(() => {
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

describe("useInboxLive", () => {
	it("reports Live only while a stream is open", () => {
		const { result } = renderHook(() => useInboxLive("inbox_a", true), {
			wrapper: wrapper(makeClient()),
		});

		expect(sources()).toHaveLength(1);
		expect(result.current.watching).toBe(false);
		act(() => latest().onopen?.());
		expect(result.current.watching).toBe(true);
		expect(result.current.stopped).toBe(false);
	});

	it("merges a streamed capture into the list the first fetch filled", () => {
		const client = makeClient();
		client.setQueryData<InboxCapturesResponse>(queryKeys.inbox.captures("inbox_a"), {
			data: [],
			pagination: { total: 0, limit: 50, offset: 0, returned: 0, hasMore: false },
		});
		renderHook(() => useInboxLive("inbox_a", true), { wrapper: wrapper(client) });

		act(() =>
			latest().onmessage?.(
				new MessageEvent("message", {
					lastEventId: "7",
					data: JSON.stringify({
						id: 7,
						inboxId: "inbox_a",
						method: "POST",
						path: "/hook",
					}),
				})
			)
		);

		const cached = client.getQueryData<InboxCapturesResponse>(
			queryKeys.inbox.captures("inbox_a")
		);
		expect(cached?.data.map((c) => c.id)).toEqual([7]);
	});

	it("reconnects after a drop and comes back to Live", async () => {
		const { result } = renderHook(() => useInboxLive("inbox_a", true), {
			wrapper: wrapper(makeClient()),
		});
		act(() => latest().onopen?.());

		const dropped = latest();
		await dropAndWait();

		// The dead source is closed rather than left to a browser retry that a
		// 409 has already made fatal, and a fresh one takes its place.
		expect(dropped.closed).toBe(true);
		expect(sources()).toHaveLength(2);
		expect(result.current.stopped).toBe(false);

		act(() => latest().onopen?.());
		expect(result.current.watching).toBe(true);
	});

	it("resumes from the last capture it saw, so the gap is not lost", async () => {
		renderHook(() => useInboxLive("inbox_a", true), { wrapper: wrapper(makeClient()) });
		act(() => latest().onopen?.());
		expect(latest().url).not.toContain("lastEventId");

		act(() =>
			latest().onmessage?.(
				new MessageEvent("message", {
					lastEventId: "12",
					data: JSON.stringify({
						id: 12,
						inboxId: "inbox_a",
						method: "GET",
						path: "/hook",
					}),
				})
			)
		);
		await dropAndWait();

		// A header is not settable on a fresh EventSource, so the resume point
		// travels as the query parameter the engine reads on the same terms.
		expect(latest().url).toContain("lastEventId=12");
	});

	it("gives up after a bounded number of refusals and offers a resume", async () => {
		const { result } = renderHook(() => useInboxLive("inbox_a", true), {
			wrapper: wrapper(makeClient()),
		});

		// A persistent 409 never opens, so every attempt fails the same way.
		for (let attempt = 0; attempt <= INBOX_LIVE_MAX_RETRIES; attempt++) {
			await dropAndWait();
		}

		expect(sources()).toHaveLength(INBOX_LIVE_MAX_RETRIES + 1);
		expect(result.current.watching).toBe(false);
		expect(result.current.stopped).toBe(true);

		// And it stays given up on: no further source appears on its own.
		act(() => void vi.advanceTimersByTime(INBOX_LIVE_RETRY_MAX_MS * 10));
		expect(sources()).toHaveLength(INBOX_LIVE_MAX_RETRIES + 1);

		act(() => result.current.resume());
		expect(sources()).toHaveLength(INBOX_LIVE_MAX_RETRIES + 2);
		expect(result.current.stopped).toBe(false);
		act(() => latest().onopen?.());
		expect(result.current.watching).toBe(true);
	});

	it("cancels a scheduled retry on unmount", async () => {
		const { unmount } = renderHook(() => useInboxLive("inbox_a", true), {
			wrapper: wrapper(makeClient()),
		});
		act(() => latest().onopen?.());
		await act(async () => void latest().onerror?.());

		const openedBeforeUnmount = sources().length;
		unmount();
		act(() => void vi.advanceTimersByTime(INBOX_LIVE_RETRY_MAX_MS * 10));

		expect(sources()).toHaveLength(openedBeforeUnmount);
	});

	it("cancels a scheduled retry when the inbox changes, and starts the new one clean", async () => {
		const { result, rerender } = renderHook(
			({ id }: { id: string }) => useInboxLive(id, true),
			{ wrapper: wrapper(makeClient()), initialProps: { id: "inbox_a" } }
		);
		act(() => latest().onopen?.());
		act(() =>
			latest().onmessage?.(
				new MessageEvent("message", {
					lastEventId: "3",
					data: JSON.stringify({
						id: 3,
						inboxId: "inbox_a",
						method: "GET",
						path: "/hook",
					}),
				})
			)
		);
		await act(async () => void latest().onerror?.());
		const openedForA = sources().length;

		rerender({ id: "inbox_b" });
		act(() => void vi.advanceTimersByTime(INBOX_LIVE_RETRY_MAX_MS * 10));

		// One new source, for the new inbox - the old inbox's pending retry did
		// not fire - and no resume point, since a capture id belongs to the
		// inbox that recorded it.
		expect(sources()).toHaveLength(openedForA + 1);
		expect(latest().url).toContain("inbox_b");
		expect(latest().url).not.toContain("lastEventId");
		expect(result.current.watching).toBe(false);
	});

	it("opens nothing for a stopped inbox", () => {
		const { result } = renderHook(() => useInboxLive("inbox_a", false), {
			wrapper: wrapper(makeClient()),
		});
		expect(sources()).toHaveLength(0);
		expect(result.current.watching).toBe(false);
		expect(result.current.stopped).toBe(false);
	});
});

/**
 * What the tab does: the engine's record decides whether a stream is wanted, so
 * a stop issued anywhere reaches the stream through the list (issue #554).
 */
function useWatchedInbox(inboxId: string) {
	const { data: inboxes = [] } = useInboxesQuery();
	const inbox = inboxes.find((i) => i.inboxId === inboxId);
	const live = useInboxLive(inboxId, inbox?.running !== false);
	return { live, running: inbox?.running };
}

describe("a stop issued outside this tab", () => {
	it("reaches the surface within the close, not on the next poll", async () => {
		const { result } = renderHook(() => useWatchedInbox("inbox_a"), {
			wrapper: wrapper(makeClient()),
		});
		await act(async () => {});
		act(() => latest().onopen?.());
		expect(result.current.live.watching).toBe(true);

		// Stopped from the drawer, an MCP tool or curl: the listener goes and
		// the stream ends exactly the way a dropped connection does.
		listInboxes.mockResolvedValue([record({ running: false })]);
		await act(async () => void latest().onerror?.());

		// No timer has advanced, so this cannot have come from the poll.
		expect(result.current.running).toBe(false);

		await act(async () => void vi.advanceTimersByTime(INBOX_LIVE_RETRY_MAX_MS * 2));

		// And the retry budget is untouched: no reconnect was attempted against
		// a listener that is gone on purpose, and the surface does not offer the
		// Resume that belongs to a stream which gave up.
		expect(sources()).toHaveLength(1);
		expect(result.current.live.watching).toBe(false);
		expect(result.current.live.stopped).toBe(false);
	});

	it("is told apart from a genuine drop, which still reconnects", async () => {
		const { result } = renderHook(() => useWatchedInbox("inbox_a"), {
			wrapper: wrapper(makeClient()),
		});
		await act(async () => {});
		act(() => latest().onopen?.());

		// Same close, but the engine still lists the listener as running.
		await dropAndWait();

		expect(sources()).toHaveLength(2);
		expect(result.current.running).toBe(true);
	});
});
