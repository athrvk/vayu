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
 * Finding the runs an agent started (issue #1817).
 *
 * One Select with two halves behind it: the kind is asked of the engine
 * (`origin=`) so an agent's run older than the loaded pages is reachable, and a
 * client under "Agents" narrows the loaded rows by name. The per-client
 * entries wait for a second client: one agent is not a choice.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useHistoryStore } from "@/modules/history/history-store";
import HistoryList from "./HistoryList";

/** What the list asked the engine for, per render. */
const runsQueryCalls: { origin: string | undefined }[] = [];

const queryState = { rows: [] as unknown[] };

function infinite(rows: unknown[]) {
	return {
		pages: [
			{
				data: rows,
				pagination: {
					total: rows.length,
					limit: 50,
					offset: 0,
					hasMore: false,
					returned: rows.length,
				},
			},
		],
		pageParams: [0],
	};
}

vi.mock("@/queries", () => ({
	useRunsQuery: (_q?: string, _pinnedOnly = false, origin?: string) => {
		runsQueryCalls.push({ origin });
		return {
			data: infinite(queryState.rows),
			isLoading: false,
			isError: false,
			error: null,
			refetch: vi.fn(),
			fetchNextPage: vi.fn(),
			hasNextPage: false,
			isFetchingNextPage: false,
		};
	},
	useDeleteRunMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useSetRunBaselineMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	flattenRunPages: (d: { pages?: Array<{ data: unknown[] }> } | undefined) =>
		d?.pages?.flatMap((p) => p.data) ?? [],
	runsTotal: (d: { pages?: Array<{ pagination: { total: number } }> } | undefined) =>
		d?.pages?.[0]?.pagination.total ?? 0,
	useCollectionsQuery: () => ({ data: [] }),
}));

vi.mock("./RunItem", () => ({
	default: ({ run }: { run: { id: string } }) => <div>row-{run.id}</div>,
}));

function renderList() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<TooltipProvider>
				<HistoryList />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

function run(id: string, client?: string | null, kind: "app" | "mcp" = "mcp") {
	return {
		id,
		type: "design",
		status: "completed",
		startTime: 1,
		origin: { kind, client: client ?? null },
		summary: { url: `http://${id}.test/` },
	};
}

function lastQuery() {
	return runsQueryCalls[runsQueryCalls.length - 1];
}

function originSelect() {
	return screen.getByRole("combobox", { name: "Origin" });
}

function choose(name: string) {
	fireEvent.click(originSelect());
	fireEvent.click(screen.getByRole("option", { name }));
}

function optionNames() {
	fireEvent.click(originSelect());
	const names = screen.getAllByRole("option").map((o) => o.textContent);
	fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
	return names;
}

beforeEach(() => {
	runsQueryCalls.length = 0;
	useHistoryStore.getState().resetFilters();
	queryState.rows = [
		run("a1", null, "app"),
		run("c1", "cursor-vscode"),
		run("k1", "windsurf-client"),
		run("k2", "Windsurf"),
	];
});

describe("the history sidebar's origin filter", () => {
	it("asks the engine for every origin until one is chosen", () => {
		renderList();
		expect(lastQuery().origin).toBeUndefined();
		expect(originSelect()).toHaveTextContent("All origins");
	});

	it("asks for agents' runs once Agents is chosen, and for the app's once App is", () => {
		renderList();
		choose("Agents");
		expect(lastQuery().origin).toBe("mcp");
		expect(useHistoryStore.getState().filterOrigin).toBe("mcp");
		expect(screen.queryByText("row-a1")).not.toBeInTheDocument();
		expect(screen.getByText("row-c1")).toBeInTheDocument();

		choose("App");
		expect(lastQuery().origin).toBe("app");
		expect(screen.getByText("row-a1")).toBeInTheDocument();
		expect(screen.queryByText("row-c1")).not.toBeInTheDocument();
	});

	it("lists one entry per client, folding two spellings of one product, once there are several", () => {
		renderList();
		expect(optionNames()).toEqual(["All origins", "App", "Agents", "Cursor", "Windsurf"]);
	});

	it("offers no per-client entries for a single agent", () => {
		queryState.rows = [run("a1", null, "app"), run("c1", "cursor-vscode"), run("c2", "Cursor")];
		renderList();
		expect(optionNames()).toEqual(["All origins", "App", "Agents"]);
	});

	it("narrows to one client without asking the engine for anything but the kind", () => {
		renderList();
		choose("Windsurf");

		expect(lastQuery().origin).toBe("mcp");
		expect(useHistoryStore.getState().filterClient).toBe("Windsurf");
		expect(originSelect()).toHaveTextContent("Windsurf");
		expect(screen.getByText("row-k1")).toBeInTheDocument();
		expect(screen.getByText("row-k2")).toBeInTheDocument();
		expect(screen.queryByText("row-c1")).not.toBeInTheDocument();
		// The other clients stay choosable after narrowing to one.
		expect(optionNames()).toContain("Cursor");
	});

	it("clears the origin along with the rest from the empty state", () => {
		queryState.rows = [];
		renderList();
		choose("Agents");
		expect(screen.getByText(/Try widening the search/i)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Clear the filters" }));
		expect(useHistoryStore.getState().filterOrigin).toBe("all");
		expect(useHistoryStore.getState().filterClient).toBeNull();
		expect(lastQuery().origin).toBeUndefined();
		expect(screen.queryByRole("button", { name: "Clear the filters" })).toBeNull();
	});

	it("clears a chosen client from the empty state too", () => {
		queryState.rows = [];
		useHistoryStore.getState().setFilterOrigin("mcp");
		useHistoryStore.getState().setFilterClient("Cursor");
		renderList();

		fireEvent.click(screen.getByRole("button", { name: "Clear the filters" }));
		expect(useHistoryStore.getState().filterOrigin).toBe("all");
		expect(useHistoryStore.getState().filterClient).toBeNull();
	});

	it("does not offer to clear anything on an empty list with no filter on", () => {
		queryState.rows = [];
		renderList();
		expect(screen.queryByRole("button", { name: "Clear the filters" })).toBeNull();
		expect(within(document.body).getByText("No test runs found")).toBeInTheDocument();
	});
});
