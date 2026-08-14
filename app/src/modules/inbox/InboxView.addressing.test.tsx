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
 * Which inbox the tab is showing (issue #554).
 *
 * The tab is a singleton and used to have no address at all: it rendered
 * whichever inbox its own start mutation had last named, falling back to the
 * first the engine listed. So a drawer row labelled "Open inbox on port 41235"
 * opened a tab showing port 41234, and nothing in the tab could switch. The
 * address now lives in the tab's `entityId`, written by the drawer row and by
 * the switcher in this header, and read back here.
 *
 * The transport is mocked and the real query hooks run, so the surface reaches
 * its inbox the way the app does.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTabsStore } from "@/stores";
import type { Inbox } from "@/types";
import type { InboxLiveState } from "./useInboxLive";

const listInboxes = vi.fn();
const listInboxCaptures = vi.fn();
const startInbox = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listInboxCaptures: (...a: unknown[]) => listInboxCaptures(...a),
			startInbox: (...a: unknown[]) => startInbox(...a),
		},
	};
});

// The stream itself is #506's subject and needs an EventSource; this file is
// about which inbox the surface is pointed at.
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

const second = inbox({ inboxId: "inbox_b", port: 41235, url: "http://127.0.0.1:41235/" });

/** Open the tab at @p entityId, the way the drawer row or a restore would. */
function openInboxTab(entityId: string | null) {
	useTabsStore.getState().openTab({ type: "inbox", entityId });
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
	listInboxes.mockReset().mockResolvedValue([inbox(), second]);
	listInboxCaptures.mockReset().mockResolvedValue({
		data: [],
		pagination: { total: 0, limit: 50, offset: 0, returned: 0, hasMore: false },
	});
	startInbox.mockReset().mockResolvedValue(second);
	useTabsStore.setState({ openTabs: [], activeTabId: null, tabFocusedAt: {} });
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn() } });
	// jsdom has no layout, so the scroll the Select does to its checked item on
	// open is absent rather than a no-op (same stub as `CodeSection.test.tsx`).
	Element.prototype.scrollIntoView = vi.fn();
});

describe("the inbox the tab shows", () => {
	it("is the one the tab was opened for, not the first the engine listed", async () => {
		openInboxTab("inbox_b");
		renderTab();

		expect(await screen.findByText("http://127.0.0.1:41235/")).toBeInTheDocument();
		expect(screen.queryByText("http://127.0.0.1:41234/")).not.toBeInTheDocument();
		// The captures it asks for belong to that inbox too - a header naming one
		// inbox over another's list is the same lie one layer down.
		await waitFor(() => expect(listInboxCaptures).toHaveBeenCalledWith("inbox_b"));
	});

	it("falls back to a stable choice when the tab names no inbox", async () => {
		// The engine lists in map order, which is not stable across polls, so the
		// fallback orders by port rather than taking whatever came back first.
		listInboxes.mockResolvedValue([second, inbox()]);
		openInboxTab(null);
		renderTab();

		expect(await screen.findByText("http://127.0.0.1:41234/")).toBeInTheDocument();
	});

	it("falls back when the tab names an inbox this engine no longer has", async () => {
		// Tabs are persisted and an inbox is engine-process state, so a restored
		// tab routinely addresses an id from a previous run.
		openInboxTab("inbox_from_a_previous_engine");
		renderTab();

		expect(await screen.findByText("http://127.0.0.1:41234/")).toBeInTheDocument();
	});
});

describe("the header's inbox switcher", () => {
	it("moves the tab to the inbox picked, without going back through the drawer", async () => {
		openInboxTab("inbox_a");
		renderTab();
		await screen.findByText("http://127.0.0.1:41234/");

		fireEvent.click(screen.getByRole("combobox", { name: "Inbox" }));
		fireEvent.click(await screen.findByRole("option", { name: /Port 41235/ }));

		expect(await screen.findByText("http://127.0.0.1:41235/")).toBeInTheDocument();
		// Written to the tab, not to a second copy of the selection beside it:
		// one address is what keeps the drawer and this switcher agreeing.
		const tab = useTabsStore.getState().openTabs.find((t) => t.type === "inbox");
		expect(tab?.entityId).toBe("inbox_b");
	});

	it("names each inbox by port and says which are stopped", async () => {
		listInboxes.mockResolvedValue([inbox(), { ...second, running: false }]);
		openInboxTab("inbox_a");
		renderTab();
		await screen.findByText("http://127.0.0.1:41234/");

		fireEvent.click(screen.getByRole("combobox", { name: "Inbox" }));

		expect(await screen.findByRole("option", { name: "Port 41234" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Port 41235 (stopped)" })).toBeInTheDocument();
	});

	it("is absent for a single inbox, where it could only pick what is shown", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		openInboxTab("inbox_a");
		renderTab();
		await screen.findByText("http://127.0.0.1:41234/");

		expect(screen.queryByRole("combobox", { name: "Inbox" })).not.toBeInTheDocument();
	});
});

describe("starting an inbox from the tab", () => {
	it("points the tab at what it started", async () => {
		listInboxes.mockResolvedValue([]);
		renderTab();

		fireEvent.click(await screen.findByRole("button", { name: /start inbox/i }));

		await waitFor(() =>
			expect(useTabsStore.getState().openTabs.find((t) => t.type === "inbox")?.entityId).toBe(
				"inbox_b"
			)
		);
	});
});
