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
 * The capture list's honesty (issue #556).
 *
 * The tab fetched one page of `INBOX_CAPTURES_PAGE_LIMIT` and stopped: the
 * engine's `hasMore` was written into the cache and read by nothing, so an
 * inbox holding its full retained ring showed the newest 50 and read exactly
 * like an inbox that had received 50. The same cache entry is written by three
 * things - the first fetch, these load-more pages, and the live stream - and
 * before this the fetch *replaced* rather than merged, so a capture streamed in
 * while the GET was in flight was overwritten when the GET resolved.
 *
 * The transport is mocked and the real query hooks run, so paging and the merge
 * go through the same cache the app uses. The live stream is mocked, and its
 * writes are made here the way the hook makes them - `mergeCapture` into the
 * captures key - so this exercises the merge rather than a stand-in for it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { mergeCapture, queryKeys } from "@/queries";
import { useTabsStore } from "@/stores";
import type { Inbox, InboxCapture, InboxCapturesResponse } from "@/types";
import type { InboxLiveState } from "./useInboxLive";

const listInboxes = vi.fn();
const listInboxCaptures = vi.fn();
const clearInboxCaptures = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listInboxCaptures: (...a: unknown[]) => listInboxCaptures(...a),
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
		captureCount: 0,
		response: { status: 200, body: "", headers: {}, delayMs: 0 },
		...overrides,
	};
}

function capture(id: number, overrides: Partial<InboxCapture> = {}): InboxCapture {
	return {
		id,
		inboxId: "inbox_a",
		receivedAt: 1700000000000,
		method: "POST",
		path: `/hook/${id}`,
		query: "",
		headers: {},
		body: "{}",
		bodyBytes: 2,
		bodyTruncated: false,
		remoteAddr: "127.0.0.1",
		...overrides,
	};
}

/**
 * One engine page: `count` captures counting down from `newestId`, newest
 * first, taken at `offset` of `total`. `hasMore` is computed the way the engine
 * computes it, so a page that lies about the tail cannot be written by accident.
 */
function page(newestId: number, count: number, total: number, offset = 0): InboxCapturesResponse {
	const data = Array.from({ length: count }, (_, i) => capture(newestId - i));
	return {
		data,
		pagination: { total, limit: 50, offset, returned: count, hasMore: offset + count < total },
	};
}

function renderTab() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const view = render(
		<QueryClientProvider client={client}>
			<InboxView />
		</QueryClientProvider>
	);
	return { client, ...view };
}

beforeEach(() => {
	cleanup();
	listInboxes.mockReset().mockResolvedValue([inbox()]);
	listInboxCaptures.mockReset().mockResolvedValue(page(0, 0, 0));
	clearInboxCaptures.mockReset().mockResolvedValue({ inboxId: "inbox_a", cleared: 2 });
	useTabsStore.setState({ openTabs: [], activeTabId: null, tabFocusedAt: {} });
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn() } });
	Element.prototype.scrollIntoView = vi.fn();
});

describe("captures past the first page", () => {
	it("says how much of the inbox is on screen, and loads the rest", async () => {
		listInboxCaptures.mockResolvedValueOnce(page(120, 50, 120));
		renderTab();

		// The cut has to be visible: without this line the list is indisting-
		// uishable from an inbox that received exactly one page.
		expect(await screen.findByText("Showing 50 of 120")).toBeInTheDocument();

		listInboxCaptures.mockResolvedValueOnce(page(70, 50, 120, 50));
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));

		// The offset is the accumulated length, not a page counter - the stream
		// prepends everything recorded since, so what is on screen is always the
		// newest N and the next unseen capture sits at exactly N.
		await waitFor(() => expect(listInboxCaptures).toHaveBeenCalledWith("inbox_a", 50, 50));
		expect(await screen.findByText("Showing 100 of 120")).toBeInTheDocument();
		// Appended, not replaced.
		expect(screen.getByText("/hook/120")).toBeInTheDocument();
		expect(screen.getByText("/hook/21")).toBeInTheDocument();
	});

	it("offers nothing to load when the list already holds everything", async () => {
		listInboxCaptures.mockResolvedValueOnce(page(3, 3, 3));
		renderTab();

		await screen.findByText("/hook/3");
		expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
		expect(screen.queryByText(/^Showing /)).not.toBeInTheDocument();
	});

	/*
	 * A background refetch of the first page reports `hasMore` from the engine's
	 * point of view - "this inbox holds more than one page" - which says nothing
	 * about whether this list has already loaded it. Trusting it alone leaves a
	 * Load more that fetches an offset past the end and appends nothing.
	 */
	it("stops offering more once the tail is loaded, whatever a first page says", async () => {
		listInboxCaptures.mockResolvedValueOnce(page(60, 50, 60));
		const { client } = renderTab();

		listInboxCaptures.mockResolvedValueOnce(page(10, 10, 60, 50));
		fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument()
		);

		// A refetch of the first page, which reports `hasMore: true` because the
		// inbox holds more than one page. Mutation check: take that answer alone
		// and the button comes back, over a list already holding all 60.
		listInboxCaptures.mockResolvedValue(page(60, 50, 60));
		await act(async () => {
			await client.refetchQueries({ queryKey: queryKeys.inbox.captures("inbox_a") });
		});
		// A second flush, deliberately: the refetch resolves inside the act above
		// but the render it causes lands a microtask later, and asserting before
		// it would find no button whatever the code does - passing for the wrong
		// reason.
		await act(async () => {});
		expect(screen.queryByRole("button", { name: /Load more|Loading/ })).not.toBeInTheDocument();
	});
});

describe("the stream and the fetch writing one list", () => {
	it("keeps a capture streamed in while the first fetch was in flight", async () => {
		let resolvePage: (value: InboxCapturesResponse) => void = () => {};
		listInboxCaptures.mockReturnValueOnce(
			new Promise<InboxCapturesResponse>((resolve) => {
				resolvePage = resolve;
			})
		);
		const { client } = renderTab();
		await waitFor(() => expect(listInboxCaptures).toHaveBeenCalled());

		// What `useInboxLive` does on an SSE frame, while the GET is unresolved.
		await act(async () => {
			client.setQueryData<InboxCapturesResponse>(
				queryKeys.inbox.captures("inbox_a"),
				(cached) => mergeCapture(cached, capture(9, { path: "/streamed" }))
			);
		});
		expect(await screen.findByText("/streamed")).toBeInTheDocument();

		await act(async () => {
			resolvePage(page(1, 1, 1));
		});

		// Mutation check: return the fetched page instead of merging it in, and
		// the streamed row is gone from a list that had already shown it.
		expect(await screen.findByText("/hook/1")).toBeInTheDocument();
		expect(screen.getByText("/streamed")).toBeInTheDocument();
	});

	it("does not resurrect cleared captures on the refetch that follows a clear", async () => {
		listInboxCaptures.mockResolvedValue(page(2, 2, 2));
		renderTab();
		await screen.findByText("/hook/2");

		// The engine has emptied the list, so the refetch the clear triggers
		// brings back nothing - and the merge must not union it onto the rows
		// the clear destroyed, which is why the clear empties the cache first.
		listInboxCaptures.mockResolvedValue(page(0, 0, 0));
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));

		await waitFor(() => expect(clearInboxCaptures).toHaveBeenCalledWith("inbox_a"));
		await waitFor(() => expect(screen.queryByText("/hook/2")).not.toBeInTheDocument());
	});
});

describe("reading one capture while others arrive", () => {
	it("keeps the clicked capture selected as new rows push it down", async () => {
		listInboxCaptures.mockResolvedValue(page(3, 3, 3));
		const { client } = renderTab();

		fireEvent.click(await screen.findByText("/hook/2"));
		expect(await screen.findByText("http://127.0.0.1:41234/hook/2")).toBeInTheDocument();

		act(() => {
			client.setQueryData<InboxCapturesResponse>(
				queryKeys.inbox.captures("inbox_a"),
				(cached) => mergeCapture(cached, capture(4))
			);
		});
		await screen.findByText("/hook/4");

		// The pane still shows what is being read, and the row it came from is
		// still the highlighted one - the detail pane falls back to the newest
		// capture only before anything has been picked.
		expect(screen.getByText("http://127.0.0.1:41234/hook/2")).toBeInTheDocument();
		const selected = screen.getByText("/hook/2").closest("button");
		expect(selected).toHaveAttribute("aria-current", "true");
	});
});

describe("what a stopped inbox still offers", () => {
	/*
	 * The panel's own stopped behaviour is covered in
	 * `CannedResponseControls.test.tsx`; this is the wiring, which is the half
	 * that goes missing - the prop existed and nothing passed it.
	 */
	it("hands the canned panel the stopped state, so it stops taking edits", async () => {
		listInboxes.mockResolvedValue([inbox({ running: false })]);
		renderTab();

		expect(await screen.findByLabelText("Reply status")).toBeDisabled();
		expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
	});

	it("leaves them live while the listener is", async () => {
		renderTab();
		expect(await screen.findByLabelText("Reply status")).toBeEnabled();
	});
});

describe("a body the engine only kept a prefix of", () => {
	it("marks the truncation in the row, not only in the detail pane", async () => {
		listInboxCaptures.mockResolvedValue({
			data: [capture(1, { bodyBytes: 900000, bodyTruncated: true })],
			pagination: { total: 1, limit: 50, offset: 0, returned: 1, hasMore: false },
		});
		renderTab();

		const row = (await screen.findByText("/hook/1")).closest("button");
		expect(row).not.toBeNull();
		// Scanning for the payload that broke something, "900000 bytes" alone is
		// a row whose body is a prefix and does not say so.
		expect(
			within(row as HTMLElement).getByText(/900000 bytes \(truncated\)/)
		).toBeInTheDocument();
	});
});
