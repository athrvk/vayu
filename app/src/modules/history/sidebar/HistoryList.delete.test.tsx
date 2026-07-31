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
 * Deleting a run that is still in progress (#124).
 *
 * The engine now stops an active run before deleting it, and refuses with a 409
 * when the run's worker has not finished writing - nothing is removed in that
 * case. Both facts have to reach the user: the confirm dialog has to say the
 * delete will stop the run, and the refusal has to say the run is still there.
 *
 * The failure path is the one that was missing entirely - `mutateAsync` was
 * awaited with no catch, so a rejected delete left an unhandled rejection and a
 * row that silently stayed put.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { ApiError } from "@/services";
import { useTabsStore } from "@/stores";
import HistoryList from "./HistoryList";

const showToast = vi.fn();
const mutateAsync = vi.fn();

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

const queryState = {
	rows: [] as unknown[],
};

vi.mock("@/queries", () => ({
	useRunsQuery: () => ({
		data: infinite(queryState.rows),
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
		fetchNextPage: vi.fn(),
		hasNextPage: false,
		isFetchingNextPage: false,
	}),
	useDeleteRunMutation: () => ({ mutateAsync, isPending: false }),
	flattenRunPages: (d: { pages?: Array<{ data: unknown[] }> } | undefined) =>
		d?.pages?.flatMap((p) => p.data) ?? [],
	runsTotal: (d: { pages?: Array<{ pagination: { total: number } }> } | undefined) =>
		d?.pages?.[0]?.pagination.total ?? 0,
}));

// The row only has to offer the delete affordance the dialog hangs off.
vi.mock("./RunItem", () => ({
	default: ({
		run,
		onDelete,
	}: {
		run: { id: string };
		onDelete: (id: string, e: React.MouseEvent) => void;
	}) => <button onClick={(e) => onDelete(run.id, e)}>delete-{run.id}</button>,
}));

vi.mock("@/stores", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/stores")>();
	return {
		...actual,
		useToastStore: (selector: (s: { showToast: typeof showToast }) => unknown) =>
			selector({ showToast }),
	};
});

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

function run(over: Record<string, unknown> = {}) {
	return {
		id: "r1",
		type: "load",
		status: "completed",
		startTime: 1,
		summary: { url: "http://x.test/" },
		...over,
	};
}

async function openDeleteDialog() {
	renderList();
	screen.getByRole("button", { name: "delete-r1" }).click();
	await waitFor(() => expect(screen.getByText("Delete run?")).toBeInTheDocument());
}

async function confirmDelete() {
	const confirm = screen
		.getAllByRole("button")
		.find((b) => /^delete$/i.test(b.textContent?.trim() ?? ""));
	expect(confirm).toBeDefined();
	confirm!.click();
}

beforeEach(() => {
	showToast.mockReset();
	mutateAsync.mockReset();
	mutateAsync.mockResolvedValue(undefined);
	queryState.rows = [run()];
});

describe("HistoryList delete confirmation", () => {
	it("warns that deleting an in-progress run stops it first", async () => {
		queryState.rows = [run({ status: "running" })];
		await openDeleteDialog();

		expect(screen.getByText(/deleting it stops it first/i)).toBeInTheDocument();
	});

	it("says nothing about stopping for a finished run", async () => {
		await openDeleteDialog();

		expect(screen.getByText(/permanently removed/i)).toBeInTheDocument();
		expect(screen.queryByText(/stops it first/i)).not.toBeInTheDocument();
	});
});

describe("HistoryList when the delete is refused", () => {
	it("explains a 409 as the run still stopping", async () => {
		mutateAsync.mockRejectedValue(new ApiError(409, "UNKNOWN_ERROR", "HTTP 409: Conflict", {}));
		await openDeleteDialog();
		await confirmDelete();

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				"This run is still stopping - try deleting it again in a moment",
				"error"
			)
		);
	});

	it("surfaces any other failure rather than swallowing it", async () => {
		mutateAsync.mockRejectedValue(new Error("Network error: engine unreachable"));
		await openDeleteDialog();
		await confirmDelete();

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				"Couldn't delete run: Network error: engine unreachable",
				"error"
			)
		);
	});

	it("stays quiet when the delete succeeds", async () => {
		await openDeleteDialog();
		await confirmDelete();

		await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith("r1"));
		expect(showToast).not.toHaveBeenCalled();
	});
});

/**
 * Tabs are persisted, so a run tab left open after its run is deleted is not
 * merely stale - it rehydrates into a pane that can never load, on every
 * restart, forever. Deleting a request already closes its tabs; a run did not.
 */
describe("HistoryList closing the deleted run's tab", () => {
	beforeEach(() => {
		useTabsStore.setState({ openTabs: [], activeTabId: null });
		useTabsStore.getState().openTab({ type: "run", entityId: "r1" });
	});

	it("closes the run's tab once the engine has deleted it", async () => {
		await openDeleteDialog();
		await confirmDelete();

		await waitFor(() => expect(useTabsStore.getState().openTabs).toHaveLength(0));
	});

	it("keeps the tab when the delete was refused - the run is still there", async () => {
		mutateAsync.mockRejectedValue(new ApiError(409, "UNKNOWN_ERROR", "HTTP 409: Conflict", {}));
		await openDeleteDialog();
		await confirmDelete();

		await waitFor(() => expect(showToast).toHaveBeenCalled());
		expect(useTabsStore.getState().openTabs.map((t) => t.entityId)).toEqual(["r1"]);
	});
});
