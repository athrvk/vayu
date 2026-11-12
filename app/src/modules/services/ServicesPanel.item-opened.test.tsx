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
 * A Services row opens its tab and tells the drawer, so an overlay can leave
 * (#3507). Both row kinds open a tab: the inbox row and the mock server row.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { DrawerItemOpenedProvider } from "@/components/layout/drawer-item-opened";
import { useEngineStore, useTabsStore } from "@/stores";
import type { Inbox, MockServer } from "@/types";
import ServicesPanel from "./ServicesPanel";

const listInboxes = vi.fn();
const listMockServers = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listMockIssuers: () => Promise.resolve([]),
			listMockServers: () => listMockServers(),
		},
	};
});

const inbox = {
	inboxId: "inbox_a",
	port: 41234,
	url: "http://127.0.0.1:41234/",
	running: true,
	allowedOrigins: [],
	captureCount: 0,
	createdAt: 1700000000000,
} as unknown as Inbox;

const mock = {
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
	allowedOrigins: [],
} as MockServer;

const onItemOpened = vi.fn();

beforeEach(() => {
	cleanup();
	onItemOpened.mockClear();
	listInboxes.mockReset().mockResolvedValue([inbox]);
	listMockServers.mockReset().mockResolvedValue([mock]);
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useEngineStore.setState({ engineStatus: "connected", engineCrash: null });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<DrawerItemOpenedProvider value={onItemOpened}>
					<ServicesPanel />
				</DrawerItemOpenedProvider>
			</TooltipProvider>
		</QueryClientProvider>
	);
});

describe("the services rows' opens", () => {
	it("tells the drawer after the inbox row opens its tab", async () => {
		fireEvent.click(await screen.findByRole("button", { name: /open inbox.*port 41234/i }));
		expect(useTabsStore.getState().openTabs.map((t) => t.type)).toEqual(["inbox"]);
		expect(onItemOpened).toHaveBeenCalledTimes(1);
	});

	it("tells the drawer after the mock server row opens its tab", async () => {
		fireEvent.click(await screen.findByRole("button", { name: /open mock server/i }));
		expect(useTabsStore.getState().openTabs.map((t) => t.type)).toEqual(["mock-server"]);
		expect(onItemOpened).toHaveBeenCalledTimes(1);
	});
});
