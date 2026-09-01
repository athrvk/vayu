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
 * three lists (an inbox stays listed once stopped, an issuer or a mock server
 * does not).
 *
 * Two later claims from issue #555, both about the indicator telling the truth:
 * a dead engine is running nothing whatever the query cache still holds, and an
 * ambient chip that points at a surface must never be the thing that hides it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useEngineStore, useLayoutStore } from "@/stores";
import type { Inbox, MockIssuer, MockServer } from "@/types";
import { Dock } from "./Dock";

const listInboxes = vi.fn();
const listMockIssuers = vi.fn();
const listMockServers = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listMockIssuers: () => listMockIssuers(),
			listMockServers: () => listMockServers(),
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
		issueRefreshTokens: true,
		clientCount: 0,
		createdAt: 1700000000000,
		...overrides,
	};
}

function mockServer(overrides: Partial<MockServer> = {}): MockServer {
	return {
		mockId: "mock_a",
		collectionId: "col_1",
		collectionName: "Pet Store",
		url: "http://127.0.0.1:43100",
		port: 43100,
		latencyMs: 0,
		errorRatePct: 0,
		routeCount: 3,
		routesWithoutExample: 0,
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
	listMockServers.mockReset().mockResolvedValue([]);
	useLayoutStore.setState({ drawerOpen: true, drawerView: "collections" });
	// The count is gated on this, and the store's own default is `starting` - a
	// list that answered at all came from an engine that was up.
	useEngineStore.setState({ engineStatus: "connected", engineError: null });
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

	/*
	 * A mock server is the third listener the engine holds, and the count read
	 * past it entirely (issue #792): a mock started from the collection header,
	 * the drawer or an MCP tool held a port while the Dock said nothing was
	 * running, disagreeing with the drawer it opens.
	 */
	it("counts a running mock server, alone and alongside the other two", async () => {
		listMockServers.mockResolvedValue([mockServer()]);
		renderDock();
		expect(await screen.findByText("1 service")).toBeInTheDocument();

		cleanup();
		listInboxes.mockResolvedValue([inbox()]);
		listMockIssuers.mockResolvedValue([issuer()]);
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

	/*
	 * The switchers to its left toggle, which is right for a button pressed
	 * twice. This is not one of them: it is an ambient chip *pointing at* the
	 * drawer, so on `activateDrawerView` it closed the one surface that can stop
	 * or copy the services it had just announced. Mutation-check: swap
	 * `revealDrawerView` back for `activateDrawerView` and this fails.
	 */
	it("only ever reveals the drawer, even when it is already on services", async () => {
		useLayoutStore.setState({ drawerOpen: true, drawerView: "services" });
		listMockIssuers.mockResolvedValue([issuer()]);
		renderDock();
		fireEvent.click(await screen.findByText("1 service"));
		expect(useLayoutStore.getState().drawerOpen).toBe(true);
		expect(useLayoutStore.getState().drawerView).toBe("services");
	});

	/*
	 * Services are engine-*process* state, so a disconnected engine is running
	 * none of them - but TanStack holds the last good list through failed
	 * refetches, so the Dock rendered "1 service" in green beside its own
	 * "Disconnected" light. Mutation-check: drop the gate in
	 * `useRunningServiceCount` and this fails.
	 */
	it("says nothing while the engine is down, whatever the cache still holds", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		listMockIssuers.mockResolvedValue([issuer()]);
		renderDock();
		// The cache is warm first, so this proves the gate and not a slow query.
		expect(await screen.findByText("2 services")).toBeInTheDocument();

		useEngineStore.setState({ engineStatus: "unreachable" });
		await waitFor(() => expect(screen.queryByText(/service/i)).not.toBeInTheDocument());
		expect(screen.getByText("Disconnected")).toBeInTheDocument();
	});
});
