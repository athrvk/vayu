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
 * The Services drawer's mock-servers group (issue #481 phase 2).
 *
 * The group's job is not "list a URL" - the collection header already shows
 * that for the collection you are looking at. It is the one place a mock
 * started anywhere (another collection, an MCP tool, curl) can be found,
 * inspected and stopped, which is what these cases assert.
 *
 * The transport is mocked and the real query hooks run, so stopping a mock goes
 * through the same mutation and cache invalidation the app uses; only the HTTP
 * call is faked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore, useToastStore } from "@/stores";
import type { MockServer } from "@/types";
import ServicesPanel from "./ServicesPanel";

const listMockServers = vi.fn();
const stopMockServer = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => Promise.resolve([]),
			listMockIssuers: () => Promise.resolve([]),
			listMockServers: () => listMockServers(),
			stopMockServer: (...a: unknown[]) => stopMockServer(...a),
		},
	};
});

const writeText = vi.fn();

function mock(overrides: Partial<MockServer> = {}): MockServer {
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
	listMockServers.mockReset().mockResolvedValue([]);
	stopMockServer.mockReset().mockResolvedValue({ mockId: "mock_a", stopped: true });
	writeText.mockReset().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
	useToastStore.setState({ toasts: [] });
});

describe("the mock servers group", () => {
	it("says where a mock comes from, since the group cannot start one", async () => {
		renderPanel();
		expect(await screen.findByText("Mock servers")).toBeInTheDocument();
		expect(screen.getByText(/Open a collection and start one/i)).toBeInTheDocument();
		// No create affordance here on purpose: a mock needs a collection, and
		// this drawer has none selected.
		expect(screen.queryByRole("button", { name: /new mock/i })).not.toBeInTheDocument();
	});

	it("leads with the collection, because two mocks of one differ only by port", async () => {
		listMockServers.mockResolvedValue([
			mock({ mockId: "mock_b", port: 43200 }),
			mock({ mockId: "mock_a", port: 43100 }),
		]);
		renderPanel();

		await screen.findAllByText("Pet Store");
		expect(screen.getByText("Port 43100")).toBeInTheDocument();
		expect(screen.getByText("Port 43200")).toBeInTheDocument();

		// By port, not by engine map order: the list must not reshuffle on a poll.
		const ports = screen.getAllByText(/^Port 43\d00$/).map((node) => node.textContent);
		expect(ports).toEqual(["Port 43100", "Port 43200"]);
	});

	/*
	 * The route table moved to the mock-server tab (issue #481 phase 3): the
	 * row's job here is just to open it, addressed at the mock it names.
	 */
	it("opens the mock-server tab addressed at the row's own mock", async () => {
		listMockServers.mockResolvedValue([mock()]);
		renderPanel();

		fireEvent.click(await screen.findByRole("button", { name: /open mock server/i }));

		expect(useTabsStore.getState().openTabs).toContainEqual(
			expect.objectContaining({ type: "mock-server", entityId: "mock_a" })
		);
	});

	it("retargets the tab rather than opening a second one for a different mock", async () => {
		listMockServers.mockResolvedValue([
			mock({ mockId: "mock_a", port: 43100 }),
			mock({ mockId: "mock_b", port: 43200 }),
		]);
		renderPanel();

		const activators = await screen.findAllByRole("button", { name: /open mock server/i });
		fireEvent.click(activators[0]);
		fireEvent.click(activators[1]);

		const mockServerTabs = useTabsStore
			.getState()
			.openTabs.filter((t) => t.type === "mock-server");
		expect(mockServerTabs).toHaveLength(1);
		expect(mockServerTabs[0].entityId).toBe("mock_b");
	});

	it("copies the base URL rather than making it read off the row", async () => {
		listMockServers.mockResolvedValue([mock()]);
		renderPanel();

		fireEvent.click(await screen.findByRole("button", { name: "Copy mock server URL" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:43100"));
	});

	it("stops a mock and drops it from the list", async () => {
		// The engine drops the record with the listener, so every list after
		// the stop is empty - which is what the invalidation has to pick up.
		listMockServers.mockResolvedValueOnce([mock()]).mockResolvedValue([]);
		renderPanel();

		fireEvent.click(
			await screen.findByRole("button", { name: /stop mock server on port 43100/i })
		);
		await waitFor(() => expect(stopMockServer).toHaveBeenCalledWith("mock_a"));
		await waitFor(() =>
			expect(screen.getByText(/Open a collection and start one/i)).toBeInTheDocument()
		);
	});

	it("reports a failed stop instead of leaving the row looking stopped", async () => {
		listMockServers.mockResolvedValue([mock()]);
		stopMockServer.mockRejectedValue(new Error("Mock server not found"));
		renderPanel();

		fireEvent.click(
			await screen.findByRole("button", { name: /stop mock server on port 43100/i })
		);
		await waitFor(() =>
			expect(useToastStore.getState().toasts[0]?.message).toBe("Mock server not found")
		);
	});

	it("names the accessible row content rather than replacing it", async () => {
		listMockServers.mockResolvedValue([mock()]);
		renderPanel();

		// The same rule the inbox and issuer rows follow: the verb is prefixed
		// sr-only text, so a screen reader still hears the collection and port.
		const activator = await screen.findByRole("button", { name: /open mock server/i });
		expect(within(activator).getByText("Pet Store")).toBeInTheDocument();
		expect(within(activator).getByText("Port 43100")).toBeInTheDocument();
	});
});
