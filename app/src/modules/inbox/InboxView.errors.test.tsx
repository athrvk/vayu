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
 * One error discipline across the inbox lifecycle (issue #555, item 7).
 *
 * Every other mutation on an inbox already toasted its failure - start and
 * update here, delete in the shared deletion hook, stop from the Services
 * drawer row. This tab's own Stop and Clear passed no `onError` at all, so a
 * refused call left a button that had visibly done nothing and put the reason
 * nowhere but devtools. Two surfaces acting on one lifecycle cannot report
 * failure two different ways, and "not at all" is the worse of the two.
 *
 * Mutation-check: drop the `onError` from either `mutate` call in
 * `modules/inbox/index.tsx` and the matching case here fails.
 *
 * The header's copy control answers to the same discipline and is pinned at the
 * bottom of this file (issue #565, item 1) - it is not a mutation, but it is
 * the other thing on this tab that can fail and used to say it had not.
 *
 * The transport is mocked and the real query hooks run, so a refusal travels
 * the same mutation path the app uses.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTabsStore, useToastStore } from "@/stores";
import type { Inbox, InboxCapture } from "@/types";
import type { InboxLiveState } from "./useInboxLive";

const listInboxes = vi.fn();
const listInboxCaptures = vi.fn();
const stopInbox = vi.fn();
const clearInboxCaptures = vi.fn();
const writeText = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listInboxCaptures: (...a: unknown[]) => listInboxCaptures(...a),
			stopInbox: (...a: unknown[]) => stopInbox(...a),
			clearInboxCaptures: (...a: unknown[]) => clearInboxCaptures(...a),
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
		captureCount: 1,
		response: { status: 200, body: "", headers: {}, delayMs: 0 },
		...overrides,
	};
}

function capture(): InboxCapture {
	return {
		id: 1,
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

function renderTab() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<InboxView />
		</QueryClientProvider>
	);
}

const firstToast = () => useToastStore.getState().toasts[0];

beforeEach(() => {
	cleanup();
	listInboxes.mockReset().mockResolvedValue([inbox()]);
	listInboxCaptures.mockReset().mockResolvedValue({
		data: [capture()],
		pagination: { total: 1, limit: 50, offset: 0, returned: 1, hasMore: false },
	});
	stopInbox.mockReset().mockResolvedValue(inbox({ running: false }));
	clearInboxCaptures.mockReset().mockResolvedValue({ inboxId: "inbox_a", cleared: 1 });
	useTabsStore.setState({ openTabs: [], activeTabId: null, tabFocusedAt: {} });
	useToastStore.setState({ toasts: [] });
	writeText.mockReset().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
});

describe("a refused mutation in the inbox tab", () => {
	it("says why the stop did not happen", async () => {
		stopInbox.mockRejectedValue(new Error("inbox is already stopped"));
		renderTab();

		fireEvent.click(await screen.findByRole("button", { name: /stop/i }));
		await waitFor(() =>
			expect(firstToast()).toMatchObject({
				variant: "error",
				message: "inbox is already stopped",
			})
		);
	});

	it("says why the captures were not cleared", async () => {
		clearInboxCaptures.mockRejectedValue(new Error("database is locked"));
		renderTab();

		// Clear is disabled until the list has something in it, so the click
		// would otherwise land on a dead button and prove nothing.
		await screen.findByText("/hook");
		fireEvent.click(screen.getByRole("button", { name: /clear/i }));
		await waitFor(() =>
			expect(firstToast()).toMatchObject({ variant: "error", message: "database is locked" })
		);
	});

	/*
	 * A transport that rejects with something other than an Error - a bare
	 * string from a failed parse - still has to reach the user as words, not as
	 * silence or "[object Object]".
	 */
	it("falls back to a named reason when the failure is not an Error", async () => {
		stopInbox.mockRejectedValue("boom");
		renderTab();

		fireEvent.click(await screen.findByRole("button", { name: /stop/i }));
		await waitFor(() =>
			expect(firstToast()).toMatchObject({
				variant: "error",
				message: "Could not stop the inbox",
			})
		);
	});

	it("stays quiet when the call succeeds", async () => {
		renderTab();
		fireEvent.click(await screen.findByRole("button", { name: /stop/i }));
		await waitFor(() => expect(stopInbox).toHaveBeenCalledWith("inbox_a"));
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});
});

/*
 * The same discipline for the copy control (issue #565, item 1). The drawer's
 * row got the awaiting path in #555 item 6; this header button kept the defect
 * that fix removed - `void writeText(...)` and an unconditional "copied", so a
 * refusal read as a success and the rejection went unhandled. Both surfaces now
 * take the same `useCopy`.
 *
 * Mutation-check: point the button back at a bare `void
 * navigator.clipboard.writeText` with an unconditional success toast and the
 * refusal case here fails.
 */
describe("the inbox tab's copy control", () => {
	it("does not claim a copy that the clipboard refused", async () => {
		writeText.mockRejectedValue(new Error("Clipboard write denied"));
		renderTab();

		fireEvent.click(await screen.findByRole("button", { name: "Copy inbox URL" }));
		await waitFor(() => expect(firstToast()).toMatchObject({ variant: "error" }));
		expect(firstToast().message).toMatch(/Clipboard write denied/);
	});

	it("names the failure even when the rejection is not an Error", async () => {
		writeText.mockRejectedValue("denied");
		renderTab();

		fireEvent.click(await screen.findByRole("button", { name: "Copy inbox URL" }));
		await waitFor(() =>
			expect(firstToast()).toMatchObject({ variant: "error", message: "Could not copy" })
		);
	});

	it("says so when the copy worked", async () => {
		renderTab();

		fireEvent.click(await screen.findByRole("button", { name: "Copy inbox URL" }));
		await waitFor(() =>
			expect(firstToast()).toMatchObject({
				variant: "success",
				message: "Inbox URL copied",
			})
		);
		expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:41234/");
	});
});
