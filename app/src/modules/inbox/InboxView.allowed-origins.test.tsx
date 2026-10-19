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
 * The inbox's CORS policy, set at start and shown while it runs (#2367).
 *
 * The one-click start must stay one click and keep sending `{}`; the options
 * dialog beside it is the only way a list reaches the engine. And the policy
 * the engine echoes has to be read somewhere, or the field is recorded and
 * never shown.
 *
 * Mutation-check: drop `allowedOrigins` from the dialog's `mutate` call and the
 * "sends the origins" case fails; drop the header line and the display cases do.
 *
 * The transport is mocked and the real query hooks run.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore, useToastStore } from "@/stores";
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
		allowedOrigins: [],
		response: { status: 200, body: "", headers: {}, delayMs: 0 },
		...overrides,
	};
}

function renderTab() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<InboxView />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	cleanup();
	listInboxes.mockReset().mockResolvedValue([]);
	listInboxCaptures.mockReset().mockResolvedValue({
		data: [],
		pagination: { total: 0, limit: 50, offset: 0, returned: 0, hasMore: false },
	});
	startInbox.mockReset().mockResolvedValue(inbox());
	useTabsStore.setState({ openTabs: [], activeTabId: null, tabFocusedAt: {} });
	useToastStore.setState({ toasts: [] });
});

const openOptions = async () => {
	fireEvent.click(await screen.findByRole("button", { name: "Inbox options" }));
	return within(await screen.findByRole("dialog"));
};

describe("starting an inbox with an origin policy", () => {
	it("keeps the one-click start sending nothing but the defaults", async () => {
		renderTab();
		fireEvent.click(await screen.findByRole("button", { name: "Start inbox" }));
		await waitFor(() => expect(startInbox).toHaveBeenCalledWith({}));
	});

	it("sends the origins that were listed, in the engine's spelling", async () => {
		renderTab();
		const dialog = await openOptions();
		fireEvent.change(dialog.getByRole("textbox", { name: /allowed origins/i }), {
			target: { value: "https://App.example.com:443\n\nhttp://localhost:5173" },
		});
		fireEvent.click(dialog.getByRole("button", { name: "Start inbox" }));

		await waitFor(() =>
			expect(startInbox).toHaveBeenCalledWith({
				allowedOrigins: ["https://app.example.com", "http://localhost:5173"],
			})
		);
		// Started: the form goes, and the tab opens on the new inbox.
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(useTabsStore.getState().openTabs).toContainEqual(
			expect.objectContaining({ type: "inbox", entityId: "inbox_a" })
		);
	});

	it("sends {} for the options dialog opened and submitted untouched", async () => {
		renderTab();
		const dialog = await openOptions();
		fireEvent.click(dialog.getByRole("button", { name: "Start inbox" }));
		await waitFor(() => expect(startInbox).toHaveBeenCalledWith({}));
	});

	it("says what is wrong with an origin, and sends nothing", async () => {
		renderTab();
		const dialog = await openOptions();
		fireEvent.change(dialog.getByRole("textbox", { name: /allowed origins/i }), {
			target: { value: "*" },
		});

		expect(dialog.getByRole("alert")).toHaveTextContent(/Couldn't use "\*" - it is a wildcard/);
		const start = dialog.getByRole("button", { name: "Start inbox" });
		expect(start).toBeDisabled();
		fireEvent.click(start);
		expect(startInbox).not.toHaveBeenCalled();
	});

	it("shows the engine's refusal in the form and leaves the dialog open", async () => {
		startInbox.mockRejectedValue(new Error("Invalid 'allowedOrigins[0]': 'x' must start"));
		renderTab();
		const dialog = await openOptions();
		fireEvent.change(dialog.getByRole("textbox", { name: /allowed origins/i }), {
			target: { value: "https://a.example" },
		});
		fireEvent.click(dialog.getByRole("button", { name: "Start inbox" }));

		expect(await dialog.findByText(/Invalid 'allowedOrigins\[0\]'/)).toBeInTheDocument();
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});
});

describe("the policy a running inbox shows", () => {
	it("says any origin for the default", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		renderTab();
		expect(await screen.findByText("Origins: any")).toBeInTheDocument();
	});

	it("lists the origins it was started with", async () => {
		listInboxes.mockResolvedValue([
			inbox({ allowedOrigins: ["https://app.example.com", "http://localhost:5173"] }),
		]);
		renderTab();
		expect(
			await screen.findByText("Origins: https://app.example.com, http://localhost:5173")
		).toBeInTheDocument();
		expect(screen.queryByText("Origins: any")).not.toBeInTheDocument();
	});

	it("offers the options beside Start new on a stopped inbox", async () => {
		listInboxes.mockResolvedValue([inbox({ running: false })]);
		renderTab();
		await screen.findByRole("button", { name: "Start new" });
		const dialog = await openOptions();
		fireEvent.change(dialog.getByRole("textbox", { name: /allowed origins/i }), {
			target: { value: "https://a.example" },
		});
		fireEvent.click(dialog.getByRole("button", { name: "Start inbox" }));
		await waitFor(() =>
			expect(startInbox).toHaveBeenCalledWith({ allowedOrigins: ["https://a.example"] })
		);
	});
});
