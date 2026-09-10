/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import MockServerView from "./index";
import {
	useMockActivityQuery,
	useMockServerRoutesQuery,
	useMockServersQuery,
	useStopMockServerMutation,
} from "@/queries";
import { useTabsStore } from "@/stores";
import type { MockActivityEntry, MockServer, MockServerRoute } from "@/types";

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useMockServersQuery: vi.fn(),
	useMockServerRoutesQuery: vi.fn(),
	useMockActivityQuery: vi.fn(),
	useStopMockServerMutation: vi.fn(),
}));

const MOCK: MockServer = {
	mockId: "mock_a",
	collectionId: "col_1",
	collectionName: "Pets",
	url: "http://127.0.0.1:9000",
	port: 9000,
	latencyMs: 0,
	errorRatePct: 0,
	routeCount: 1,
	routesWithoutExample: 0,
	createdAt: 0,
};

const ROUTE: MockServerRoute = {
	requestId: "req_1",
	requestName: "List pets",
	method: "GET",
	path: "/pets",
	hasExample: true,
	status: 200,
	mode: "first",
	exampleName: "Default",
	hits: 3,
};

const ENTRY: MockActivityEntry = {
	at: 0,
	method: "GET",
	path: "/pets",
	requestId: "req_1",
	requestName: "List pets",
	exampleId: "exa_1",
	exampleName: "Default",
	status: 200,
	injectedError: false,
};

describe("MockServerView", () => {
	beforeEach(() => {
		vi.mocked(useMockServersQuery).mockReturnValue({
			data: [MOCK],
		} as ReturnType<typeof useMockServersQuery>);
		vi.mocked(useMockServerRoutesQuery).mockReturnValue({
			data: [ROUTE],
			isError: false,
		} as ReturnType<typeof useMockServerRoutesQuery>);
		vi.mocked(useMockActivityQuery).mockReturnValue({
			data: [ENTRY],
			isError: false,
		} as ReturnType<typeof useMockActivityQuery>);
		vi.mocked(useStopMockServerMutation).mockReturnValue({
			mutate: vi.fn(),
			isPending: false,
		} as unknown as ReturnType<typeof useStopMockServerMutation>);
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "mock-server", entityId: "mock_a" }],
			activeTabId: "t1",
		});
	});

	it("shows the addressed mock's route table with its mode and hits", () => {
		render(<MockServerView />);
		// Scoped to the Routes section: the same path and example name also
		// appear in the activity feed below, from the same fixture.
		const routes = within(screen.getByText("Routes (1)").closest("section")!);
		expect(routes.getByText("/pets")).toBeInTheDocument();
		expect(routes.getByText("Default")).toBeInTheDocument();
		expect(routes.getByText("3")).toBeInTheDocument();
	});

	it("shows the activity feed", () => {
		render(<MockServerView />);
		expect(screen.getAllByText("/pets").length).toBeGreaterThan(0);
	});

	it("shows an empty state when no mock is running", () => {
		vi.mocked(useMockServersQuery).mockReturnValue({
			data: [] as MockServer[],
		} as ReturnType<typeof useMockServersQuery>);
		render(<MockServerView />);
		expect(screen.getByText(/no mock running/i)).toBeInTheDocument();
	});
});
