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
 * The `Notify` toggle keeps its promise from another tab (issue #1400).
 *
 * The tooltip says a capture notifies "while Vayu is in the background", and
 * getting there ordinarily means clicking a request tab on the way out of the
 * window. One tab's surface is mounted at a time, so the stream the inbox view
 * owned went with it and the toggle silently did nothing. These cases mount the
 * app-level watcher over a tab that switches, which is the shape `App` and
 * `Shell` have.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { useClientSettingsStore, useInboxNotifyStore } from "@/stores";
import { INBOX_CAPTURE_NOTIFY_WINDOW_MS } from "@/modules/inbox/capture-notifier";
import { inboxWatchService } from "@/services/inbox-watch-service";
import { useInboxLive } from "@/modules/inbox/useInboxLive";
import type { Inbox } from "@/types";
import { useInboxWatchers } from "./useInboxWatchers";

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

/** The source addressing @p inboxId, whether or not it has since closed. */
function sourceFor(inboxId: string) {
	return sources().find((s) => s.url.includes(`/inbox/${inboxId}/`));
}

function capture(inboxId: string, id: number) {
	return new MessageEvent("message", {
		lastEventId: String(id),
		data: JSON.stringify({ id, inboxId, method: "POST", path: "/hook" }),
	});
}

const showNotification = vi.fn();

/** What `App` does over what `Shell` shows: one watcher, one tab at a time. */
function AppLike({ start = "inbox" }: { start?: "inbox" | "request" }) {
	const [tab, setTab] = useState(start);
	useInboxWatchers();
	return (
		<>
			<button type="button" onClick={() => setTab("request")}>
				Open request tab
			</button>
			{tab === "inbox" ? <InboxTab /> : <p>A request</p>}
		</>
	);
}

/** The inbox view's whole relationship to the stream. */
function InboxTab() {
	const live = useInboxLive("inbox_a", true);
	return <p>{live.watching ? "Live" : "Running"}</p>;
}

function renderApp(props: { start?: "inbox" | "request" } = {}) {
	return render(
		<QueryClientProvider client={queryClient}>
			<AppLike {...props} />
		</QueryClientProvider>
	);
}

/** Let the inbox list resolve and the effects reading it run. */
async function settle() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
}

beforeEach(() => {
	MockEventSource.instances = [];
	listInboxes.mockReset().mockResolvedValue([record()]);
	showNotification.mockReset().mockResolvedValue("shown");
	vi.stubGlobal("EventSource", MockEventSource);
	vi.stubGlobal("electronAPI", { showNotification });
	vi.useFakeTimers();
	queryClient.clear();
	useClientSettingsStore.setState({ systemNotifications: true });
	useInboxNotifyStore.setState({ enabled: {} });
});

afterEach(() => {
	inboxWatchService.stopAll();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("useInboxWatchers", () => {
	it("notifies for a capture that arrives after the user left the inbox tab", async () => {
		// The bug, end to end: with the stream owned by the view, the click below
		// closed the socket and the capture after it announced nothing.
		// Mutation check: unmount the watcher, or make it reconcile only the
		// inbox on screen, and this reddens.
		useInboxNotifyStore.getState().setEnabled("inbox_a", true);
		const { getByText } = renderApp();
		await settle();
		const source = sourceFor("inbox_a");
		expect(source).toBeDefined();

		act(() => getByText("Open request tab").click());
		expect(source?.closed).toBe(false);

		act(() => source?.onmessage?.(capture("inbox_a", 7)));
		act(() => void vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS));

		expect(showNotification).toHaveBeenCalledTimes(1);
		expect(showNotification.mock.calls[0][0]).toMatchObject({
			kind: "inbox-captured",
			body: "POST /hook",
			target: { view: "inbox", inboxId: "inbox_a" },
		});
	});

	it("watches a second notifying inbox no tab has ever addressed", async () => {
		// Two running inboxes, one tab: the one not on screen is exactly the case
		// the per-inbox toggle exists for.
		listInboxes.mockResolvedValue([record(), record({ inboxId: "inbox_b", port: 4101 })]);
		useInboxNotifyStore.getState().setEnabled("inbox_b", true);
		renderApp();
		await settle();

		const source = sourceFor("inbox_b");
		expect(source).toBeDefined();

		act(() => source?.onmessage?.(capture("inbox_b", 3)));
		act(() => void vi.advanceTimersByTime(INBOX_CAPTURE_NOTIFY_WINDOW_MS));

		expect(showNotification.mock.calls[0][0]).toMatchObject({
			target: { view: "inbox", inboxId: "inbox_b" },
		});
	});

	it("closes the stream when the toggle goes off", async () => {
		useInboxNotifyStore.getState().setEnabled("inbox_b", true);
		listInboxes.mockResolvedValue([record(), record({ inboxId: "inbox_b", port: 4101 })]);
		renderApp({ start: "request" });
		await settle();
		expect(sourceFor("inbox_b")?.closed).toBe(false);

		await act(async () => {
			useInboxNotifyStore.getState().setEnabled("inbox_b", false);
		});

		expect(sourceFor("inbox_b")?.closed).toBe(true);
	});

	it("closes the stream when the engine says the inbox has stopped", async () => {
		useInboxNotifyStore.getState().setEnabled("inbox_b", true);
		listInboxes.mockResolvedValue([record(), record({ inboxId: "inbox_b", port: 4101 })]);
		renderApp({ start: "request" });
		await settle();
		expect(sourceFor("inbox_b")?.closed).toBe(false);

		listInboxes.mockResolvedValue([
			record(),
			record({ inboxId: "inbox_b", port: 4101, running: false }),
		]);
		await act(async () => {
			await queryClient.refetchQueries({ queryKey: queryKeys.inbox.list() });
		});
		await settle();

		expect(sourceFor("inbox_b")?.closed).toBe(true);
	});

	it("prunes a toggle whose inbox the engine no longer lists", async () => {
		// An inbox id dies with the engine process that minted it, so a persisted
		// map would otherwise grow one dead entry per inbox ever started (#1388).
		useInboxNotifyStore.getState().setEnabled("inbox_gone", true);
		renderApp({ start: "request" });
		await settle();

		expect(useInboxNotifyStore.getState().enabled).toEqual({});
	});

	it("keeps every preference when the list could not be read", async () => {
		// "No inboxes" and "could not ask" are not the same answer, and only one
		// of them is evidence that an id is dead.
		listInboxes.mockRejectedValue(new Error("engine unreachable"));
		useInboxNotifyStore.setState({ enabled: { inbox_a: true, inbox_gone: true } });
		renderApp({ start: "request" });
		await settle();

		expect(useInboxNotifyStore.getState().enabled).toEqual({
			inbox_a: true,
			inbox_gone: true,
		});
	});

	it("does not observe the inbox list while no inbox may notify", async () => {
		// The list polls every ten seconds for the app's whole life, and a root
		// observer nobody reads is what #1150 removed.
		// Mutation check: drop the `enabled` gate and this reddens.
		renderApp({ start: "request" });
		await settle();
		act(() => void vi.advanceTimersByTime(60_000));

		expect(listInboxes).not.toHaveBeenCalled();
	});
});
