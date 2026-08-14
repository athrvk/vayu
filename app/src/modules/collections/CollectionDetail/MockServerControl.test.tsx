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
 * The collection header's mock-server control (issue #481 phase 2).
 *
 * This is the only surface that can *start* a mock, because it is the only one
 * that has a collection. What it has to get right is which mock it is talking
 * about: the engine's list is every mock in the process, and a header showing a
 * different collection's URL - or offering "Run mock server" beside one that is
 * already running - is worse than showing nothing.
 *
 * The transport is mocked and the real query hooks run, so starting and
 * stopping go through the same mutations and cache invalidation the app uses.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useToastStore } from "@/stores";
import type { MockServer } from "@/types";
import MockServerControl from "./MockServerControl";
import { mockForCollection } from "./mock-server-selection";

const listMockServers = vi.fn();
const startMockServer = vi.fn();
const stopMockServer = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listMockServers: () => listMockServers(),
			startMockServer: (...a: unknown[]) => startMockServer(...a),
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

function renderControl(collectionId = "col_1") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<MockServerControl collectionId={collectionId} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	cleanup();
	listMockServers.mockReset().mockResolvedValue([]);
	startMockServer.mockReset().mockResolvedValue(mock());
	stopMockServer.mockReset().mockResolvedValue({ mockId: "mock_a", stopped: true });
	writeText.mockReset().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	useToastStore.setState({ toasts: [] });
});

describe("picking the mock this header is about", () => {
	it("ignores mocks of other collections", () => {
		const mine = mock({ mockId: "mock_mine", collectionId: "col_1" });
		const theirs = mock({ mockId: "mock_theirs", collectionId: "col_2", port: 43000 });
		expect(mockForCollection([theirs, mine], "col_1")?.mockId).toBe("mock_mine");
		expect(mockForCollection([theirs], "col_1")).toBeNull();
		expect(mockForCollection([], "col_1")).toBeNull();
	});

	it("picks the lowest port when one collection has several", () => {
		// Nothing stops a user starting two mocks of one collection - different
		// latency, different error rate - and the engine lists them in map
		// order, which is not stable across polls.
		const high = mock({ mockId: "mock_high", port: 43900 });
		const low = mock({ mockId: "mock_low", port: 43100 });
		expect(mockForCollection([high, low], "col_1")?.mockId).toBe("mock_low");
		expect(mockForCollection([low, high], "col_1")?.mockId).toBe("mock_low");
	});
});

describe("the collection header's mock-server control", () => {
	it("offers to start one, and starts it for this collection", async () => {
		renderControl();

		fireEvent.click(await screen.findByRole("button", { name: /run mock server/i }));
		await waitFor(() =>
			expect(startMockServer).toHaveBeenCalledWith({ collectionId: "col_1" })
		);
		// The toast names what was started - the route count is the number that
		// says whether the mock is worth pointing anything at.
		await waitFor(() =>
			expect(useToastStore.getState().toasts[0]?.message).toMatch(/port 43100 - 3 routes/i)
		);
	});

	it("surfaces the engine's reason rather than a generic failure", async () => {
		startMockServer.mockRejectedValue(
			new Error("Collection 'Pet Store' (and everything under it) has no requests to serve")
		);
		renderControl();

		fireEvent.click(await screen.findByRole("button", { name: /run mock server/i }));
		await waitFor(() =>
			expect(useToastStore.getState().toasts[0]?.message).toMatch(/no requests to serve/i)
		);
	});

	it("shows the URL and the controls once one is running, not the start button", async () => {
		listMockServers.mockResolvedValue([mock({ routesWithoutExample: 1 })]);
		renderControl();

		expect(await screen.findByText("http://127.0.0.1:43100")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /run mock server/i })).not.toBeInTheDocument();
		// The count that explains a mock answering 501: reported, not left to be
		// discovered one request at a time.
		expect(screen.getByText(/3 routes, 1 without an example/i)).toBeInTheDocument();
	});

	it("keeps showing the start button when only another collection has a mock", async () => {
		listMockServers.mockResolvedValue([mock({ collectionId: "col_2" })]);
		renderControl("col_1");

		expect(await screen.findByRole("button", { name: /run mock server/i })).toBeInTheDocument();
		expect(screen.queryByText("http://127.0.0.1:43100")).not.toBeInTheDocument();
	});

	it("copies the base URL and stops the mock", async () => {
		listMockServers.mockResolvedValueOnce([mock()]).mockResolvedValue([]);
		renderControl();

		fireEvent.click(await screen.findByRole("button", { name: "Copy mock server URL" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:43100"));

		fireEvent.click(screen.getByRole("button", { name: /stop mock server on port 43100/i }));
		await waitFor(() => expect(stopMockServer).toHaveBeenCalledWith("mock_a"));
		// The record dies with the listener, so the header goes back to offering
		// a start rather than a stopped chip.
		expect(await screen.findByRole("button", { name: /run mock server/i })).toBeInTheDocument();
	});
});
