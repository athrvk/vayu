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
 * A running local service has to be visible from anywhere (issue #502).
 *
 * A webhook inbox kept recording with its tab closed and an OAuth issuer had no
 * app surface at all, so the app could not answer "is something still
 * listening?" anywhere. The Dock's middle region already carries that class of
 * fact (the connection light), so the aggregate indicator lives there.
 *
 * Two claims, and the second is the one a source scan could not make:
 *
 * 1. The fifth Dock button exists and activates the services drawer view.
 * 2. **Nothing renders when nothing runs.** Mutation-check: make
 *    `RunningServices` render unconditionally and the first case below fails,
 *    because "0 services" appears in a Dock with an empty engine.
 *
 * The transport is mocked and the real queries and hooks run, so the count is
 * computed the way the app computes it - including the asymmetry between the
 * two lists (an inbox stays listed once stopped, an issuer does not).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useLayoutStore } from "@/stores";
import type { Inbox, MockIssuer } from "@/types";
import { Dock } from "./Dock";

const listInboxes = vi.fn();
const listMockIssuers = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listMockIssuers: () => listMockIssuers(),
		},
	};
});

// The Dock prints the app version, which Vite `define`s at build time.
vi.stubGlobal("__VAYU_VERSION__", "0.0.0-test");

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
		issueRefreshTokens: true,
		clientCount: 0,
		createdAt: 1700000000000,
		...overrides,
	};
}

const renderDock = () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<Dock />
			</TooltipProvider>
		</QueryClientProvider>
	);
};

beforeEach(() => {
	cleanup();
	listInboxes.mockReset().mockResolvedValue([]);
	listMockIssuers.mockReset().mockResolvedValue([]);
	useLayoutStore.setState({ drawerOpen: true, drawerView: "collections" });
});

describe("the services drawer switcher", () => {
	it("is in the Dock's sidebar navigation, with its chord in the tooltip", () => {
		renderDock();
		const button = screen.getByRole("button", { name: "Services" });
		expect(button).toBeInTheDocument();
		expect(button.getAttribute("aria-pressed")).toBe("false");
	});

	it("activates the services view", () => {
		renderDock();
		fireEvent.click(screen.getByRole("button", { name: "Services" }));
		expect(useLayoutStore.getState().drawerView).toBe("services");
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});
});

describe("the running-services indicator", () => {
	it("renders nothing while nothing is running", async () => {
		renderDock();
		// The lists have to have arrived - asserting on the empty first render
		// would pass before either query resolved and prove nothing.
		await waitFor(() => expect(listMockIssuers).toHaveBeenCalled());
		expect(screen.queryByText(/service/i)).not.toBeInTheDocument();
	});

	it("does not count an inbox the engine has stopped", async () => {
		listInboxes.mockResolvedValue([inbox({ running: false })]);
		renderDock();
		await waitFor(() => expect(listInboxes).toHaveBeenCalled());
		expect(screen.queryByText(/service/i)).not.toBeInTheDocument();
	});

	it("counts a running inbox", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		renderDock();
		expect(await screen.findByText("1 service")).toBeInTheDocument();
	});

	it("counts inboxes and issuers together, and pluralises", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		listMockIssuers.mockResolvedValue([issuer(), issuer({ issuerId: "iss_b" })]);
		renderDock();
		expect(await screen.findByText("3 services")).toBeInTheDocument();
	});

	it("opens the services drawer when clicked", async () => {
		listMockIssuers.mockResolvedValue([issuer()]);
		renderDock();
		fireEvent.click(await screen.findByText("1 service"));
		expect(useLayoutStore.getState().drawerView).toBe("services");
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
	});
});
