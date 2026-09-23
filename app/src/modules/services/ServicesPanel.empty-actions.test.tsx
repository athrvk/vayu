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
 * The empty group notes are not dead ends (issue #1693).
 *
 * "No inbox yet" and "No issuer running" described a thing the user could
 * have and then offered no way to get it: the create handler lived one row
 * up, in a tooltip icon button that says nothing until you hover it. Each
 * note now carries the *same* handler that header button does, which is the
 * part worth guarding - a second, parallel create path would drift.
 */

/**
 * The Services drawer (issue #502).
 *
 * The OAuth issuer had no app surface at all before this - the engine's four
 * routes were reachable only from curl or the MCP tools - so these cases are
 * the first proof that a user can start, read and stop one. The inbox half is
 * about the second entry point: the drawer lists it and opens its tab, without
 * taking the tab's job.
 *
 * The transport is mocked and the real query hooks run, so a row acting on a
 * service goes through the same mutation and cache invalidation the app uses;
 * only the HTTP call is faked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useLayoutStore, useTabsStore, useToastStore } from "@/stores";
import type { Inbox, MockIssuer } from "@/types";
import ServicesPanel from "./ServicesPanel";

const listInboxes = vi.fn();
const listMockIssuers = vi.fn();
const startInbox = vi.fn();
const stopInbox = vi.fn();
const deleteInbox = vi.fn();
const startMockIssuer = vi.fn();
const stopMockIssuer = vi.fn();
const updateMockIssuer = vi.fn();
const listMockServers = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listMockIssuers: () => listMockIssuers(),
			startInbox: (...a: unknown[]) => startInbox(...a),
			stopInbox: (...a: unknown[]) => stopInbox(...a),
			deleteInbox: (...a: unknown[]) => deleteInbox(...a),
			startMockIssuer: (...a: unknown[]) => startMockIssuer(...a),
			stopMockIssuer: (...a: unknown[]) => stopMockIssuer(...a),
			updateMockIssuer: (...a: unknown[]) => updateMockIssuer(...a),
			listMockServers: () => listMockServers(),
		},
	};
});

const writeText = vi.fn();

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

function issuer(overrides: Partial<MockIssuer> = {}): MockIssuer {
	return {
		issuerId: "iss_a",
		issuerUrl: "http://127.0.0.1:42000",
		tokenUrl: "http://127.0.0.1:42000/token",
		authorizeUrl: "http://127.0.0.1:42000/authorize",
		signingKey: "k".repeat(32),
		port: 42000,
		expiresInSeconds: 3600,
		failureMode: "none",
		slowMs: 0,
		issueRefreshTokens: false,
		clientCount: 0,
		createdAt: 1700000000000,
		...overrides,
	};
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
	listInboxes.mockReset().mockResolvedValue([]);
	listMockIssuers.mockReset().mockResolvedValue([]);
	listMockServers.mockReset().mockResolvedValue([]);
	startInbox.mockReset().mockResolvedValue(inbox());
	stopInbox.mockReset().mockResolvedValue(inbox({ running: false }));
	deleteInbox.mockReset().mockResolvedValue({ inboxId: "inbox_a", capturesDeleted: 0 });
	startMockIssuer.mockReset().mockResolvedValue({
		issuerId: "iss_new",
		issuerUrl: "http://127.0.0.1:42001",
		tokenUrl: "http://127.0.0.1:42001/token",
		authorizeUrl: "http://127.0.0.1:42001/authorize",
		signingKey: "s".repeat(32),
	});
	stopMockIssuer.mockReset().mockResolvedValue({ stopped: true });
	updateMockIssuer.mockReset().mockResolvedValue(issuer({ failureMode: "server_error" }));
	writeText.mockReset();
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useToastStore.setState({ toasts: [] });
});

describe("the services drawer's empty groups offer the create the header offers", () => {
	it("starts an inbox from the empty inbox note", async () => {
		renderPanel();
		await screen.findByText(/records every request sent to it/i);
		// Two by design: the section header's icon button and the note's link.
		// The note's is the second, and both carry the same label because they
		// do the same thing.
		const create = screen.getAllByRole("button", { name: "New inbox" });
		expect(create).toHaveLength(2);
		fireEvent.click(create[1]);
		// The header's "New inbox" button calls the same mutation; this asserts
		// the note reaches it rather than a parallel path of its own.
		await waitFor(() => expect(startInbox).toHaveBeenCalledTimes(1));
	});

	it("opens the new-issuer dialog from the empty issuer note", async () => {
		renderPanel();
		await screen.findByText(/mint your own OAuth 2.0 tokens locally/i);
		const create = screen.getAllByRole("button", { name: "New issuer" });
		expect(create).toHaveLength(2);
		fireEvent.click(create[1]);
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
	});

	it("sends the empty mock group to the collections drawer, where a mock is started", async () => {
		useLayoutStore.setState({ drawerView: "history", drawerOpen: false });
		renderPanel();
		const browse = await screen.findByRole("button", { name: "Browse collections" });
		fireEvent.click(browse);
		// No create button here on purpose: a mock is started from a
		// collection's header, so the note points at that surface instead of
		// offering a button that would have nothing to act on.
		expect(useLayoutStore.getState().drawerView).toBe("collections");
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});
});
