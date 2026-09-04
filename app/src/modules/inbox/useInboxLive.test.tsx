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
 * The view's reference to an inbox stream it no longer owns (issue #1400).
 *
 * The socket, the reconnect and the merge belong to `inbox-watch-service`, and
 * its own tests pin those. What is left here is the part a surface can get
 * wrong: holding the stream while the tab is on screen, letting go of it
 * without closing one somebody else still wants, and rendering the state the
 * service reports for the inbox this view is addressing rather than the one it
 * was addressing a render ago.
 *
 * Driven through the real service with a stubbed `EventSource`, not a mocked
 * service: a test that asserted "retain was called" would pass with the socket
 * closed on unmount, which is the bug this issue is about.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { queryClient } from "@/lib/query-client";
import { inboxWatchService } from "@/services/inbox-watch-service";
import { useInboxLive } from "./useInboxLive";

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

function latest() {
	const all = sources();
	expect(all.length).toBeGreaterThan(0);
	return all[all.length - 1];
}

beforeEach(() => {
	MockEventSource.instances = [];
	vi.stubGlobal("EventSource", MockEventSource);
	queryClient.clear();
});

afterEach(() => {
	inboxWatchService.stopAll();
	vi.unstubAllGlobals();
});

describe("useInboxLive", () => {
	it("holds a stream for the inbox on screen and reports Live only while it is open", () => {
		const { result } = renderHook(() => useInboxLive("inbox_a", true));

		expect(sources()).toHaveLength(1);
		expect(result.current.watching).toBe(false);

		act(() => latest().onopen?.());

		expect(result.current.watching).toBe(true);
		expect(result.current.stopped).toBe(false);
	});

	it("opens nothing for a stopped inbox", () => {
		const { result } = renderHook(() => useInboxLive("inbox_a", false));

		expect(sources()).toHaveLength(0);
		expect(result.current.watching).toBe(false);
		expect(result.current.stopped).toBe(false);
	});

	it("adopts a stream the service already holds", () => {
		// The tab is reopened on an inbox that has been notifying in the
		// background: one socket, and the badge reads Live at once rather than
		// after a reconnect.
		inboxWatchService.reconcile(["inbox_a"]);
		act(() => latest().onopen?.());

		const { result } = renderHook(() => useInboxLive("inbox_a", true));

		expect(sources()).toHaveLength(1);
		expect(result.current.watching).toBe(true);
	});

	it("leaves the socket open on unmount when something else still wants it", () => {
		// The regression this issue is about, at the seam the view owns: the tab
		// switch that precedes leaving the window must not take the stream with
		// it.
		// Mutation check: drop the refcount in the service, or close on release
		// unconditionally, and this reddens.
		inboxWatchService.reconcile(["inbox_a"]);
		const { unmount } = renderHook(() => useInboxLive("inbox_a", true));

		unmount();

		expect(sources()).toHaveLength(1);
		expect(latest().closed).toBe(false);
	});

	it("closes the socket on unmount when it was the only holder", () => {
		const { unmount } = renderHook(() => useInboxLive("inbox_a", true));
		const source = latest();

		unmount();

		expect(source.closed).toBe(true);
	});

	it("moves its reference when the addressed inbox changes", () => {
		const { result, rerender } = renderHook(
			({ id }: { id: string }) => useInboxLive(id, true),
			{
				initialProps: { id: "inbox_a" },
			}
		);
		const first = latest();
		act(() => first.onopen?.());

		rerender({ id: "inbox_b" });

		expect(first.closed).toBe(true);
		expect(latest().url).toContain("inbox_b");
		// The new inbox's own state, not the badge the previous one left behind.
		expect(result.current.watching).toBe(false);
	});

	it("releases the stream when the inbox is stopped", () => {
		const { rerender } = renderHook(
			({ running }: { running: boolean }) => useInboxLive("inbox_a", running),
			{ initialProps: { running: true } }
		);
		const source = latest();

		rerender({ running: false });

		expect(source.closed).toBe(true);
	});

	it("offers a resume that re-subscribes the service", () => {
		const { result } = renderHook(() => useInboxLive("inbox_a", true));
		act(() => latest().onopen?.());

		act(() => result.current.resume());

		expect(sources()).toHaveLength(2);
	});
});
