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
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore, useToastStore } from "@/stores";
import type { Inbox, MockIssuer } from "@/types";
import ServicesPanel from "./ServicesPanel";

const listInboxes = vi.fn();
const listMockIssuers = vi.fn();
const startInbox = vi.fn();
const stopInbox = vi.fn();
const startMockIssuer = vi.fn();
const stopMockIssuer = vi.fn();
const updateMockIssuer = vi.fn();

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
			startMockIssuer: (...a: unknown[]) => startMockIssuer(...a),
			stopMockIssuer: (...a: unknown[]) => stopMockIssuer(...a),
			updateMockIssuer: (...a: unknown[]) => updateMockIssuer(...a),
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
	startInbox.mockReset().mockResolvedValue(inbox());
	stopInbox.mockReset().mockResolvedValue(inbox({ running: false }));
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

describe("the services drawer", () => {
	it("names both service kinds, so the drawer teaches what a service is", async () => {
		renderPanel();
		expect(await screen.findByText("Webhook inboxes")).toBeInTheDocument();
		expect(screen.getByText("OAuth issuers")).toBeInTheDocument();
	});

	it("says what each empty group would give you, not just that it is empty", async () => {
		renderPanel();
		expect(await screen.findByText(/records every request sent to it/i)).toBeInTheDocument();
		expect(screen.getByText(/mint your own OAuth 2.0 tokens locally/i)).toBeInTheDocument();
	});

	it("starts an inbox from the group's own affordance", async () => {
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: "Start inbox" }));
		await waitFor(() => expect(startInbox).toHaveBeenCalled());
	});
});

describe("an inbox row", () => {
	it("opens the inbox tab - the drawer lists, the tab shows the captures", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: /open inbox on port 41234/i }));
		expect(useTabsStore.getState().openTabs.map((t) => t.type)).toContain("inbox");
	});

	/*
	 * The row's label names one inbox, so the tab has to receive that one. It
	 * used to open the tab with no address at all, which the tab resolved to the
	 * first inbox in the engine's list - clicking the second row showed the
	 * first (issue #554).
	 */
	it("hands the tab the inbox the row names, not just the tab type", async () => {
		listInboxes.mockResolvedValue([
			inbox(),
			inbox({ inboxId: "inbox_b", port: 41235, url: "http://127.0.0.1:41235/" }),
		]);
		renderPanel();

		fireEvent.click(await screen.findByRole("button", { name: /open inbox on port 41235/i }));
		expect(useTabsStore.getState().openTabs).toContainEqual(
			expect.objectContaining({ type: "inbox", entityId: "inbox_b" })
		);

		// And the second row retargets the one open tab rather than opening a
		// second inbox tab.
		fireEvent.click(screen.getByRole("button", { name: /open inbox on port 41234/i }));
		const inboxTabs = useTabsStore.getState().openTabs.filter((t) => t.type === "inbox");
		expect(inboxTabs).toHaveLength(1);
		expect(inboxTabs[0].entityId).toBe("inbox_a");
	});

	it("copies the URL a webhook source is pointed at", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: "Copy inbox URL" }));
		expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:41234/");
	});

	it("stops a running inbox", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: /stop inbox on port 41234/i }));
		await waitFor(() => expect(stopInbox).toHaveBeenCalledWith("inbox_a"));
	});

	/*
	 * A stopped inbox stays listed - the engine keeps its record and its
	 * captures readable - so the row has to say which it is and drop the action
	 * that no longer applies. This is the half an issuer row does not have: a
	 * stopped issuer is gone from the engine's list entirely.
	 */
	it("marks a stopped inbox and offers no stop for it", async () => {
		listInboxes.mockResolvedValue([inbox({ running: false })]);
		renderPanel();
		expect(await screen.findByText("Stopped")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /stop inbox/i })).not.toBeInTheDocument();
	});
});

describe("an issuer row", () => {
	it("hands over the two URLs and the signing key only once expanded", async () => {
		listMockIssuers.mockResolvedValue([issuer()]);
		renderPanel();
		// Collapsed: the row is the issuer's base URL and nothing else, so a
		// drawer of eight issuers stays readable.
		expect(screen.queryByText("http://127.0.0.1:42000/token")).not.toBeInTheDocument();

		fireEvent.click(
			await screen.findByRole("button", { name: /expand issuer on port 42000/i })
		);

		expect(screen.getByText("http://127.0.0.1:42000/token")).toBeInTheDocument();
		expect(screen.getByText("http://127.0.0.1:42000/authorize")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Copy signing key" }));
		expect(writeText).toHaveBeenCalledWith("k".repeat(32));
	});

	it("summarises what the issuer will do, in its own numbers", async () => {
		listMockIssuers.mockResolvedValue([
			issuer({ expiresInSeconds: 120, failureMode: "slow", slowMs: 2000, clientCount: 2 }),
		]);
		renderPanel();
		fireEvent.click(
			await screen.findByRole("button", { name: /expand issuer on port 42000/i })
		);
		expect(
			screen.getByText(
				/Tokens expire in 120s · answers after 2000ms · 2 clients configured\./
			)
		).toBeInTheDocument();
	});

	it("flips a running issuer into a failure mode without restarting it", async () => {
		listMockIssuers.mockResolvedValue([issuer()]);
		renderPanel();
		fireEvent.click(
			await screen.findByRole("button", { name: /expand issuer on port 42000/i })
		);
		fireEvent.click(screen.getByRole("combobox"));
		fireEvent.click(screen.getByRole("option", { name: "Server error" }));
		await waitFor(() =>
			expect(updateMockIssuer).toHaveBeenCalledWith("iss_a", { failureMode: "server_error" })
		);
	});

	it("stops the issuer it names", async () => {
		listMockIssuers.mockResolvedValue([issuer()]);
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: /stop issuer on port 42000/i }));
		await waitFor(() => expect(stopMockIssuer).toHaveBeenCalledWith("iss_a"));
	});
});

describe("starting an issuer", () => {
	const openDialog = async () => {
		renderPanel();
		fireEvent.click(await screen.findByRole("button", { name: "New issuer" }));
		return within(await screen.findByRole("dialog"));
	};

	it("sends the defaults when nothing is changed - a bare start is the common case", async () => {
		const dialog = await openDialog();
		fireEvent.click(dialog.getByRole("button", { name: /start issuer/i }));
		await waitFor(() =>
			expect(startMockIssuer).toHaveBeenCalledWith({
				expiresInSeconds: 3600,
				failureMode: "none",
			})
		);
	});

	it("sends the claims the user typed", async () => {
		const dialog = await openDialog();
		fireEvent.change(dialog.getByLabelText(/claims/i), {
			target: { value: '{"sub":"alice"}' },
		});
		fireEvent.click(dialog.getByRole("button", { name: /start issuer/i }));
		await waitFor(() =>
			expect(startMockIssuer).toHaveBeenCalledWith({
				expiresInSeconds: 3600,
				failureMode: "none",
				claims: { sub: "alice" },
			})
		);
	});

	/*
	 * The engine refuses a bad config rather than falling back to a default, and
	 * a claims typo is otherwise invisible until a token comes back without the
	 * claim. So both are refused here, with the reason on the field.
	 */
	it("refuses malformed claims by name, and sends nothing", async () => {
		const dialog = await openDialog();
		fireEvent.change(dialog.getByLabelText(/claims/i), { target: { value: "{sub:" } });
		expect(dialog.getByRole("button", { name: /start issuer/i })).toBeDisabled();
		fireEvent.click(dialog.getByRole("button", { name: /start issuer/i }));
		expect(startMockIssuer).not.toHaveBeenCalled();
	});

	it("refuses a claims value that is valid JSON but not a claim set", async () => {
		const dialog = await openDialog();
		fireEvent.change(dialog.getByLabelText(/claims/i), { target: { value: '["admin"]' } });
		expect(dialog.getByText(/must be a JSON object/i)).toBeInTheDocument();
		expect(dialog.getByRole("button", { name: /start issuer/i })).toBeDisabled();
	});

	it("refuses an out-of-range lifetime", async () => {
		const dialog = await openDialog();
		fireEvent.change(dialog.getByLabelText(/token lifetime/i), { target: { value: "0" } });
		expect(dialog.getByRole("button", { name: /start issuer/i })).toBeDisabled();
	});
});
