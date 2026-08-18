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
 * The count has to name every local service the engine holds (issue #792).
 *
 * The hook counted inboxes and issuers and not mock servers, so a running mock -
 * a bound loopback listener holding a port, which is exactly what the indicator
 * exists to surface - contributed zero, and the Dock disagreed with the drawer
 * it opens. Mutation-check: drop the `mocks.length` term and the first case
 * below reads 2 instead of 3.
 *
 * The transport is mocked and the real query hooks run, so the three lists are
 * combined the way the app combines them - including their asymmetry: an inbox
 * stays listed once stopped and carries `running`, while a stopped issuer or
 * mock is gone from the engine's list entirely.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEngineStore } from "@/stores";
import type { Inbox, MockIssuer, MockServer } from "@/types";
import { useRunningServiceCount } from "./useRunningServices";

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

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function countHook() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return { client, ...renderHook(() => useRunningServiceCount(), { wrapper: wrapper(client) }) };
}

beforeEach(() => {
	listInboxes.mockReset().mockResolvedValue([]);
	listMockIssuers.mockReset().mockResolvedValue([]);
	listMockServers.mockReset().mockResolvedValue([]);
	// The count is gated on this, and the store's own default is `false` - a
	// list that answered at all came from an engine that was up.
	useEngineStore.setState({ isEngineConnected: true, engineError: null });
});

describe("useRunningServiceCount", () => {
	it("counts a mock server beside the inboxes and issuers, and not a stopped inbox", async () => {
		listInboxes.mockResolvedValue([inbox(), inbox({ inboxId: "inbox_b", running: false })]);
		listMockIssuers.mockResolvedValue([issuer()]);
		listMockServers.mockResolvedValue([mockServer()]);

		const { result } = countHook();

		await waitFor(() => expect(result.current).toBe(3));
	});

	it("counts a mock server on its own - the case the Dock reported as nothing running", async () => {
		listMockServers.mockResolvedValue([mockServer()]);

		const { result } = countHook();

		await waitFor(() => expect(result.current).toBe(1));
	});

	/*
	 * A stopped mock is *gone* from `GET /mock` rather than flagged - its record
	 * dies with its listener - so the count falls out of the shorter list, with
	 * no `running` filter to apply.
	 */
	it("drops the mock again once it is stopped", async () => {
		listMockServers.mockResolvedValue([mockServer(), mockServer({ mockId: "mock_b" })]);

		const { client, result } = countHook();
		await waitFor(() => expect(result.current).toBe(2));

		listMockServers.mockResolvedValue([mockServer()]);
		await client.invalidateQueries();

		await waitFor(() => expect(result.current).toBe(1));
	});

	/*
	 * Services are engine-*process* state, so a disconnected engine is running
	 * none of them - but TanStack holds the last good list through failed
	 * refetches. Nothing covered the gate at this level before.
	 */
	it("reports nothing while the engine is down, whatever the cache still holds", async () => {
		listMockServers.mockResolvedValue([mockServer()]);

		const { result } = countHook();
		// The cache is warm first, so this proves the gate and not a slow query.
		await waitFor(() => expect(result.current).toBe(1));

		useEngineStore.setState({ isEngineConnected: false });

		await waitFor(() => expect(result.current).toBe(0));
	});
});
