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
 * The drawer says when a `Notify` toggle is not in effect (issue #1412).
 *
 * Two ways an inbox with the toggle on hears nothing: its stream spent its
 * reconnects (#1403 resumes it a minute later, and it is silent until then), or
 * the stream cap had no slot for it and never will until one frees up. Neither
 * had a surface: the inbox tab renders the first and only while it is the tab
 * on screen, which is exactly where a user watching for background captures is
 * not. This drawer is reachable from every tab, so it is where the note goes.
 *
 * Driven through the real service rather than a stubbed summary: what is worth
 * pinning is that the state the sockets are actually in reaches the row.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useInboxNotifyStore, useTabsStore, useToastStore } from "@/stores";
import {
	INBOX_LIVE_MAX_RETRIES,
	INBOX_LIVE_RETRY_MAX_MS,
	MAX_INBOX_WATCH_STREAMS,
	inboxWatchService,
} from "@/services/inbox-watch-service";
import type { Inbox } from "@/types";
import ServicesPanel from "./ServicesPanel";

const listInboxes = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listMockIssuers: () => Promise.resolve([]),
			listMockServers: () => Promise.resolve([]),
		},
	};
});

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

/** The newest source addressing @p inboxId - a reconnect opens another. */
function latestSourceFor(inboxId: string) {
	const opened = MockEventSource.instances.filter((s) => s.url.includes(`/inbox/${inboxId}/`));
	return opened[opened.length - 1];
}

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

/** Refuse every attempt @p inboxId's budget allows, so its stream gives up. */
async function spendTheLadder(inboxId: string) {
	for (let attempt = 0; attempt < INBOX_LIVE_MAX_RETRIES; attempt++) {
		latestSourceFor(inboxId)?.onerror?.();
		await vi.advanceTimersByTimeAsync(INBOX_LIVE_RETRY_MAX_MS * 2);
	}
	latestSourceFor(inboxId)?.onerror?.();
}

function renderPanel() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<ServicesPanel />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	cleanup();
	MockEventSource.instances = [];
	listInboxes.mockReset().mockResolvedValue([inbox()]);
	vi.stubGlobal("EventSource", MockEventSource);
	vi.useFakeTimers({ shouldAdvanceTime: true });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useToastStore.setState({ toasts: [] });
	useInboxNotifyStore.setState({ enabled: { inbox_a: true } });
});

afterEach(() => {
	inboxWatchService.stopAll();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("the drawer's note that an inbox is not notifying", () => {
	it("marks an inbox whose stream gave up, and clears it when one opens", async () => {
		// The case #1403 leaves visible: the resume is a minute away, and until it
		// lands this inbox's captures reach nobody.
		// Mutation check: drop the badge and the first assertion reddens.
		renderPanel();
		inboxWatchService.reconcile(["inbox_a"]);
		expect(await screen.findByText("Port 41234")).toBeInTheDocument();

		await spendTheLadder("inbox_a");

		expect(await screen.findByText("Not notifying")).toBeInTheDocument();

		// Not on the resume - on the connection the resume gets. A stream that
		// reconnects and is refused again never stopped being silent.
		inboxWatchService.resume("inbox_a");
		expect(screen.getByText("Not notifying")).toBeInTheDocument();
		latestSourceFor("inbox_a")?.onopen?.();

		await waitFor(() => expect(screen.queryByText("Not notifying")).not.toBeInTheDocument());
	});

	it("marks an inbox the stream cap left out, and only that one", async () => {
		// Nothing is retrying for this one and nothing will: the note is the same
		// one a stalled stream gets, because what the row has room to say is that
		// the toggle is not in effect - the two causes are a docs paragraph.
		const wanted = Array.from({ length: MAX_INBOX_WATCH_STREAMS + 1 }, (_, i) =>
			inbox({ inboxId: `inbox_${i}`, port: 41234 + i, url: `http://127.0.0.1:${41234 + i}/` })
		);
		listInboxes.mockResolvedValue(wanted);
		useInboxNotifyStore.setState({
			enabled: Object.fromEntries(wanted.map((i) => [i.inboxId, true])),
		});
		renderPanel();
		inboxWatchService.reconcile(wanted.map((i) => i.inboxId));

		// Exactly the one the cap could not fit, not every inbox in the list.
		expect(await screen.findByText("Not notifying")).toBeInTheDocument();
		expect(screen.getAllByText("Not notifying")).toHaveLength(1);

		// And it clears when a slot frees up.
		inboxWatchService.reconcile(wanted.slice(0, MAX_INBOX_WATCH_STREAMS).map((i) => i.inboxId));

		await waitFor(() => expect(screen.queryByText("Not notifying")).not.toBeInTheDocument());
	});

	it("says nothing about an inbox that is being watched normally", async () => {
		renderPanel();
		inboxWatchService.reconcile(["inbox_a"]);
		expect(await screen.findByText("Port 41234")).toBeInTheDocument();
		latestSourceFor("inbox_a")?.onopen?.();

		expect(screen.queryByText(/Not notifying/)).not.toBeInTheDocument();
	});

	it("says nothing about an inbox whose toggle is off", async () => {
		// The note is about a promise not being kept. There is no promise here:
		// the stream this inbox has is the view's, not the toggle's.
		useInboxNotifyStore.setState({ enabled: {} });
		renderPanel();
		inboxWatchService.retain("inbox_a");
		expect(await screen.findByText("Port 41234")).toBeInTheDocument();

		await spendTheLadder("inbox_a");

		expect(screen.queryByText(/Not notifying/)).not.toBeInTheDocument();
	});
});
