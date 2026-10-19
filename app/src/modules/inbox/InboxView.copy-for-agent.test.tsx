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
 * "Copy for agent" on the inbox tab's header (#2047).
 *
 * A text button, so a landed copy toasts "Reference copied". It sits beside the
 * existing "Copy inbox URL" icon button and copies a different thing: the line
 * that names the inbox by id, with no URL, canned response or capture in it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, render as renderBare, screen, waitFor, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore, useToastStore } from "@/stores";
import type { Inbox } from "@/types";
import type { InboxLiveState } from "./useInboxLive";

const SENTINEL = "s3cr3t-sentinel";

const listInboxes = vi.fn();
const listInboxCaptures = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listInboxCaptures: (...a: unknown[]) => listInboxCaptures(...a),
		},
	};
});

const live: InboxLiveState = { watching: true, stopped: false, resume: vi.fn() };
vi.mock("./useInboxLive", () => ({ useInboxLive: () => live }));

const { default: InboxView } = await import("./index");

const INBOX: Inbox = {
	inboxId: "inbox_a",
	url: `http://127.0.0.1:41234/?k=${SENTINEL}`,
	bind: "127.0.0.1",
	port: 41234,
	running: true,
	loopback: true,
	captureCount: 0,
	allowedOrigins: [],
	response: { status: 200, body: SENTINEL, headers: { "X-Key": SENTINEL }, delayMs: 0 },
};

const writeText = vi.fn();

function render(ui: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return renderBare(<QueryClientProvider client={client}>{ui}</QueryClientProvider>, {
		wrapper: TooltipProvider,
	});
}

beforeEach(() => {
	cleanup();
	listInboxes.mockReset().mockResolvedValue([INBOX]);
	listInboxCaptures.mockReset().mockResolvedValue({
		data: [],
		pagination: { total: 0, limit: 50, offset: 0, returned: 0, hasMore: false },
	});
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
	useTabsStore.setState({ openTabs: [], activeTabId: null, tabFocusedAt: {} });
});

describe("Copy for agent on the inbox tab", () => {
	it("copies the formatter's line and says so", async () => {
		render(<InboxView />);
		fireEvent.click(await screen.findByRole("button", { name: "Copy for agent" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith('Vayu inbox "port 41234" (inbox_a)');
		await waitFor(() =>
			expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
				"Reference copied",
			])
		);
	});

	it("keeps the url and the canned response off the clipboard", async () => {
		render(<InboxView />);
		fireEvent.click(await screen.findByRole("button", { name: "Copy for agent" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		const copied = writeText.mock.calls[0][0] as string;
		expect(copied).not.toContain(SENTINEL);
		expect(copied).not.toContain("127.0.0.1");
	});

	it("leaves the URL copy button copying the URL", async () => {
		render(<InboxView />);
		fireEvent.click(await screen.findByRole("button", { name: "Copy inbox URL" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(INBOX.url));
	});
});
