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
import { screen, fireEvent, within } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
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
	allowedOrigins: [],
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

	it("marks a shadowed route and names the request that answers instead (#3115)", () => {
		vi.mocked(useMockServerRoutesQuery).mockReturnValue({
			data: [
				{ ...ROUTE, requestId: "req_ok", requestName: "login ok", path: "/login" },
				{
					...ROUTE,
					requestId: "req_fail",
					requestName: "login fail",
					path: "/login",
					hits: 0,
					shadowed: true,
					shadowedBy: { requestId: "req_ok", requestName: "login ok" },
				},
			],
			isError: false,
		} as ReturnType<typeof useMockServerRoutesQuery>);
		render(<MockServerView />);
		const routes = within(screen.getByText("Routes (2)").closest("section")!);
		// One mark, on the shadowed row only; the winner is not flagged.
		expect(routes.getAllByText("shadowed")).toHaveLength(1);
		expect(routes.getByText(/same method and path as login ok/i)).toHaveTextContent(
			"Same method and path as login ok, which answers instead."
		);
	});

	it("shows no shadowed mark when no route is shadowed", () => {
		render(<MockServerView />);
		const routes = within(screen.getByText("Routes (1)").closest("section")!);
		expect(routes.queryByText("shadowed")).not.toBeInTheDocument();
		expect(routes.queryByText(/same method and path/i)).not.toBeInTheDocument();
	});

	it("opens the collection this mock serves, so a page load is not a dead end", () => {
		render(<MockServerView />);
		fireEvent.click(screen.getByRole("button", { name: /open collection/i }));
		expect(useTabsStore.getState().openTabs).toContainEqual(
			expect.objectContaining({ type: "collection", entityId: "col_1" })
		);
	});

	it("shows the activity feed", () => {
		render(<MockServerView />);
		expect(screen.getAllByText("/pets").length).toBeGreaterThan(0);
	});

	it("shows the latency and error-rate summary when errorRatePct is set", () => {
		vi.mocked(useMockServersQuery).mockReturnValue({
			data: [{ ...MOCK, latencyMs: 250, errorRatePct: 30 }],
		} as ReturnType<typeof useMockServersQuery>);
		render(<MockServerView />);
		expect(screen.getByText("250ms latency, 30% of answers fail")).toBeInTheDocument();
	});

	it.each([
		[0.4, "0.4ms latency"],
		[1500, "1.50s latency"],
	])("formats a %s ms latency through formatLatency", (latencyMs, text) => {
		vi.mocked(useMockServersQuery).mockReturnValue({
			data: [{ ...MOCK, latencyMs }],
		} as ReturnType<typeof useMockServersQuery>);
		render(<MockServerView />);
		expect(screen.getByText(text)).toBeInTheDocument();
	});

	it("says any origin for the default policy", () => {
		render(<MockServerView />);
		expect(screen.getByText("Origins: any")).toBeInTheDocument();
	});

	it("lists the origins the mock was started with", () => {
		vi.mocked(useMockServersQuery).mockReturnValue({
			data: [
				{ ...MOCK, allowedOrigins: ["https://app.example.com", "http://localhost:5173"] },
			],
		} as ReturnType<typeof useMockServersQuery>);
		render(<MockServerView />);
		expect(
			screen.getByText("Origins: https://app.example.com, http://localhost:5173")
		).toBeInTheDocument();
		expect(screen.queryByText("Origins: any")).not.toBeInTheDocument();
	});

	it("labels an injected failure distinctly, regardless of requestId/exampleName", () => {
		vi.mocked(useMockActivityQuery).mockReturnValue({
			data: [
				{
					...ENTRY,
					requestId: null,
					requestName: null,
					exampleId: null,
					exampleName: null,
					status: 500,
					injectedError: true,
				},
			],
			isError: false,
		} as ReturnType<typeof useMockActivityQuery>);
		render(<MockServerView />);
		expect(screen.getByText("injected failure")).toBeInTheDocument();
		expect(screen.queryByText("unmatched")).not.toBeInTheDocument();
	});

	it("still labels a genuine miss as unmatched", () => {
		vi.mocked(useMockActivityQuery).mockReturnValue({
			data: [
				{
					...ENTRY,
					requestId: null,
					requestName: null,
					exampleId: null,
					exampleName: null,
					status: 404,
					injectedError: false,
				},
			],
			isError: false,
		} as ReturnType<typeof useMockActivityQuery>);
		render(<MockServerView />);
		expect(screen.getByText("unmatched")).toBeInTheDocument();
	});

	it("gives a 200, a 404 and a 503 three different status chips", () => {
		vi.mocked(useMockActivityQuery).mockReturnValue({
			data: [
				{ ...ENTRY, at: 1, path: "/ok", status: 200 },
				{ ...ENTRY, at: 2, path: "/missing", status: 404 },
				{ ...ENTRY, at: 3, path: "/boom", status: 503 },
			],
			isError: false,
		} as ReturnType<typeof useMockActivityQuery>);
		render(<MockServerView />);
		const activity = within(screen.getByText("Activity").closest("section")!);
		const chipFill = (code: string) =>
			activity.getByText(code).className.match(/bg-status-[\w-]+-fill/)?.[0];

		expect(chipFill("200")).toBe("bg-status-success-fill");
		expect(chipFill("404")).toBe("bg-status-warning-fill");
		expect(chipFill("503")).toBe("bg-status-error-fill");
	});

	// Issue #1928: both lists default to `[]`, so a query in flight read as a
	// mock with no routes and nothing served.
	describe("while the first fetch is in flight", () => {
		beforeEach(() => {
			vi.mocked(useMockServerRoutesQuery).mockReturnValue({
				data: undefined,
				isLoading: true,
				isError: false,
			} as ReturnType<typeof useMockServerRoutesQuery>);
			vi.mocked(useMockActivityQuery).mockReturnValue({
				data: undefined,
				isLoading: true,
				isError: false,
			} as ReturnType<typeof useMockActivityQuery>);
		});

		it("dashes the route count instead of claiming there are none", () => {
			render(<MockServerView />);
			expect(screen.getByText("Routes (-)")).toBeInTheDocument();
			expect(screen.queryByText("Routes (0)")).not.toBeInTheDocument();
		});

		it("draws a skeleton in each section, not the activity empty state", () => {
			render(<MockServerView />);
			expect(screen.queryByText(/Nothing served yet/)).not.toBeInTheDocument();
			const routes = within(screen.getByText("Routes (-)").closest("section")!);
			const activity = within(screen.getByText("Activity").closest("section")!);
			expect(routes.getByRole("status", { name: "Loading" })).toBeInTheDocument();
			expect(activity.getByRole("status", { name: "Loading" })).toBeInTheDocument();
		});

		it("gates the two sections independently", () => {
			vi.mocked(useMockServerRoutesQuery).mockReturnValue({
				data: [ROUTE],
				isError: false,
			} as ReturnType<typeof useMockServerRoutesQuery>);
			render(<MockServerView />);
			const routes = within(screen.getByText("Routes (1)").closest("section")!);
			const activity = within(screen.getByText("Activity").closest("section")!);
			expect(routes.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();
			expect(routes.getByText("/pets")).toBeInTheDocument();
			expect(activity.getByRole("status", { name: "Loading" })).toBeInTheDocument();
		});
	});

	it("still says nothing was served once the activity log has loaded empty", () => {
		vi.mocked(useMockActivityQuery).mockReturnValue({
			data: [] as MockActivityEntry[],
			isError: false,
		} as ReturnType<typeof useMockActivityQuery>);
		render(<MockServerView />);
		expect(screen.getByText(/Nothing served yet/)).toBeInTheDocument();
	});

	it("still counts a loaded, empty route table as Routes (0)", () => {
		vi.mocked(useMockServerRoutesQuery).mockReturnValue({
			data: [] as MockServerRoute[],
			isError: false,
		} as ReturnType<typeof useMockServerRoutesQuery>);
		render(<MockServerView />);
		expect(screen.getByText("Routes (0)")).toBeInTheDocument();
	});

	/**
	 * Both lists draw the method through `MethodBadge` (#2317). The inline
	 * `color` and the `title` are what a private span with a fixed column lacked.
	 */
	describe("the method column", () => {
		beforeEach(() => {
			vi.mocked(useMockServerRoutesQuery).mockReturnValue({
				data: [{ ...ROUTE, method: "DELETE" }],
				isError: false,
			} as ReturnType<typeof useMockServerRoutesQuery>);
			vi.mocked(useMockActivityQuery).mockReturnValue({
				data: [{ ...ENTRY, method: "DELETE" }],
				isError: false,
			} as ReturnType<typeof useMockActivityQuery>);
		});

		it.each(["Routes (1)", "Activity"])(
			"in the %s list is the coloured, abbreviated MethodBadge",
			(heading) => {
				render(<MockServerView />);
				const section = within(screen.getByText(heading).closest("section")!);
				const badge = section.getByText("DEL");
				expect(badge).toHaveAttribute("title", "DELETE");
				expect(badge.style.color).toContain("--method-delete");
			}
		);
	});
});
