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
 * Deleting an inbox from the tab (issue #553).
 *
 * Stopping an inbox was terminal and one-way: the record and its captures stay
 * readable for the life of the engine process, so before delete existed a
 * stopped inbox was a row nothing could remove. These cases are about the two
 * halves of doing it safely - the recorded requests are what is actually lost,
 * so the confirmation is worded from their count, and an inbox holding none is
 * deleted outright rather than made to argue for itself.
 *
 * The transport is mocked and the real query hooks run, so the delete goes
 * through the same mutation and cache invalidation the app uses.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTabsStore } from "@/stores";
import type { Inbox, InboxCapture } from "@/types";
import type { InboxLiveState } from "./useInboxLive";
import { capturesAtRisk } from "./useInboxDeletion";

const listInboxes = vi.fn();
const listInboxCaptures = vi.fn();
const deleteInbox = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listInboxCaptures: (...a: unknown[]) => listInboxCaptures(...a),
			deleteInbox: (...a: unknown[]) => deleteInbox(...a),
		},
	};
});

const live: InboxLiveState = { watching: true, stopped: false, resume: vi.fn() };
vi.mock("./useInboxLive", () => ({ useInboxLive: () => live }));

const { default: InboxView } = await import("./index");

function inbox(overrides: Partial<Inbox> = {}): Inbox {
	return {
		inboxId: "inbox_a",
		url: "http://127.0.0.1:41234/",
		bind: "127.0.0.1",
		port: 41234,
		running: true,
		loopback: true,
		captureCount: 0,
		response: { status: 200, body: "", headers: {}, delayMs: 0 },
		...overrides,
	};
}

function capture(id: number): InboxCapture {
	return {
		id,
		inboxId: "inbox_a",
		receivedAt: 1700000000000,
		method: "POST",
		path: "/hook",
		query: "",
		headers: {},
		body: "{}",
		bodyBytes: 2,
		bodyTruncated: false,
		remoteAddr: "127.0.0.1",
	};
}

function capturePage(captures: InboxCapture[]) {
	return {
		data: captures,
		pagination: {
			total: captures.length,
			limit: 50,
			offset: 0,
			returned: captures.length,
			hasMore: false,
		},
	};
}

function renderTab() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<InboxView />
		</QueryClientProvider>
	);
}

beforeEach(() => {
	cleanup();
	listInboxes.mockReset().mockResolvedValue([inbox()]);
	listInboxCaptures.mockReset().mockResolvedValue(capturePage([]));
	deleteInbox.mockReset().mockResolvedValue({ inboxId: "inbox_a", capturesDeleted: 0 });
	useTabsStore.setState({ openTabs: [], activeTabId: null, tabFocusedAt: {} });
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn() } });
	Element.prototype.scrollIntoView = vi.fn();
});

describe("deleting the inbox the tab shows", () => {
	it("asks first when captures would go with it, and names how many", async () => {
		listInboxes.mockResolvedValue([inbox({ captureCount: 2, running: false })]);
		listInboxCaptures.mockResolvedValue(capturePage([capture(1), capture(2)]));
		renderTab();

		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
		// The listener is one click to replace; the recorded requests are not,
		// so the count is what the dialog argues from.
		expect(await screen.findByText(/2 recorded requests/i)).toBeInTheDocument();
		expect(deleteInbox).not.toHaveBeenCalled();

		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(deleteInbox).toHaveBeenCalledWith("inbox_a"));
	});

	it("deletes an inbox holding nothing without asking", async () => {
		renderTab();

		fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
		await waitFor(() => expect(deleteInbox).toHaveBeenCalledWith("inbox_a"));
		expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
	});

	/*
	 * The record's count is polled every 10s while the capture list is fed by
	 * the live stream, so a webhook that has just landed is in the list and not
	 * yet in the count. Trusting the count alone would destroy it silently.
	 */
	it("still asks when only the capture list has seen the arrival", async () => {
		listInboxes.mockResolvedValue([inbox({ captureCount: 0 })]);
		listInboxCaptures.mockResolvedValue(capturePage([capture(1)]));
		renderTab();
		// The arrival has to be on screen for this to be about the two counts
		// disagreeing rather than about the list not having loaded yet.
		await screen.findByText("/hook");

		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(await screen.findByText(/1 recorded request /i)).toBeInTheDocument();
		expect(deleteInbox).not.toHaveBeenCalled();
	});

	it("falls back to the inbox that is left, without the tab being retargeted", async () => {
		const survivor = inbox({ inboxId: "inbox_b", port: 41235, url: "http://127.0.0.1:41235/" });
		listInboxes.mockResolvedValue([inbox(), survivor]);
		useTabsStore.getState().openTab({ type: "inbox", entityId: "inbox_a" });
		renderTab();

		expect(await screen.findByText("http://127.0.0.1:41234/")).toBeInTheDocument();

		listInboxes.mockResolvedValue([survivor]);
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));

		// The tab still names the deleted inbox - selection is derived, not
		// synced (issue #554) - so the surface has to resolve that itself.
		expect(await screen.findByText("http://127.0.0.1:41235/")).toBeInTheDocument();
		expect(useTabsStore.getState().openTabs.filter((t) => t.type === "inbox")).toHaveLength(1);
	});
});

describe("what a delete would cost", () => {
	it("takes whichever source has seen the newest capture", () => {
		// The drawer passes no list at all, so the record is all it has.
		expect(capturesAtRisk(inbox({ captureCount: 3 }))).toBe(3);
		// A stale record beside a live list: the list wins.
		expect(capturesAtRisk(inbox({ captureCount: 0 }), 1)).toBe(1);
		// And a list trimmed to a page never talks the count *down*.
		expect(capturesAtRisk(inbox({ captureCount: 120 }), 50)).toBe(120);
	});
});
