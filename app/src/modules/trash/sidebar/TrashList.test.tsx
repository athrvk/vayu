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
 * The Trash view (issue #989) - the app's only reader for the rows the engine
 * has been stamping since #988.
 *
 * Three of these cases exist because the engine answers with something the view
 * is the last chance to show. `reparentedToRoot` moves the user's folder and
 * the tree cannot say so; a 409 names the collection blocking a restore; the
 * cascade counts are the only place a folder in the trash is distinguishable
 * from an empty one. Each of them is a field that would otherwise be written by
 * the engine and read by nobody.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import TrashList from "./TrashList";
import type { TrashEntry } from "@/types";

const restore = vi.fn();
const purge = vi.fn();
const showToast = vi.fn();
const refetch = vi.fn();

const state: {
	items: TrashEntry[];
	isLoading: boolean;
	isError: boolean;
	retention: string | null;
} = { items: [], isLoading: false, isError: false, retention: "30" };

function collectionEntry(over: Partial<TrashEntry> = {}): TrashEntry {
	return {
		id: "c1",
		kind: "collection",
		name: "Billing",
		deletedAt: Date.now() - 60_000,
		parentId: null,
		collections: 0,
		requests: 0,
		...over,
	};
}

vi.mock("@/queries", () => ({
	useTrashQuery: () => ({
		data: { items: state.items, total: state.items.length },
		isLoading: state.isLoading,
		isError: state.isError,
		error: state.isError ? new Error("engine is not running") : null,
		refetch,
	}),
	useRestoreTrashMutation: () => ({ mutateAsync: restore, isPending: false }),
	usePurgeTrashMutation: () => ({ mutateAsync: purge, isPending: false }),
	useConfigQuery: () => ({
		data:
			state.retention === null
				? undefined
				: {
						entries: [
							{
								key: "trashRetentionDays",
								value: state.retention,
								type: "integer",
								label: "Trash retention",
								description: "",
								category: "data_retention",
								default: "30",
							},
						],
					},
	}),
}));

vi.mock("@/stores", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/stores")>();
	return {
		...actual,
		useToastStore: (selector: (s: { showToast: typeof showToast }) => unknown) =>
			selector({ showToast }),
	};
});

function renderTrash() {
	return render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<TrashList />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	restore.mockReset().mockResolvedValue({
		...collectionEntry(),
		restored: true,
		reparentedToRoot: false,
	});
	purge.mockReset().mockResolvedValue({ ...collectionEntry(), purged: true });
	showToast.mockReset();
	refetch.mockReset();
	state.items = [];
	state.isLoading = false;
	state.isError = false;
	state.retention = "30";
});

describe("the list", () => {
	it("names each deleted item and how long ago it went", () => {
		state.items = [collectionEntry({ name: "Billing" })];
		renderTrash();

		expect(screen.getByText("Billing")).toBeInTheDocument();
		expect(screen.getByText(/Deleted 1m ago/)).toBeInTheDocument();
	});

	it("says what the delete took with it, so a restore's size is visible", () => {
		// A folder in the trash is indistinguishable from an empty one without
		// this - and restoring it is a very different act at 11 requests.
		state.items = [collectionEntry({ collections: 2, requests: 11 })];
		renderTrash();

		expect(screen.getByText(/with 2 folders, 11 requests/)).toBeInTheDocument();
	});

	it("does not pluralise a single child", () => {
		state.items = [collectionEntry({ collections: 1, requests: 1 })];
		renderTrash();

		expect(screen.getByText(/with 1 folder, 1 request$/)).toBeInTheDocument();
	});

	it("states the retention window it read from the engine's config", () => {
		state.items = [collectionEntry()];
		renderTrash();

		expect(
			screen.getByText("Items are deleted for good 30 days after they land here.")
		).toBeInTheDocument();
	});

	it("claims no window at all when the config has not arrived", () => {
		state.retention = null;
		state.items = [collectionEntry()];
		renderTrash();

		expect(screen.queryByText(/deleted for good/)).not.toBeInTheDocument();
	});

	it("offers the empty state rather than a bare panel", () => {
		renderTrash();

		expect(screen.getByText("Trash is empty")).toBeInTheDocument();
	});

	it("shows a failure as a failure, not as an empty trash", () => {
		// The two states look identical to a user and mean opposite things: one
		// says nothing was deleted, the other that we cannot tell.
		state.isError = true;
		renderTrash();

		expect(screen.getByText("Couldn't load the trash")).toBeInTheDocument();
		expect(screen.queryByText("Trash is empty")).not.toBeInTheDocument();
	});
});

describe("restore", () => {
	it("restores the row it was pressed on", async () => {
		state.items = [collectionEntry()];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Restore Billing" }));

		await waitFor(() => expect(restore).toHaveBeenCalledWith("c1"));
	});

	it("says so when the engine had to put a folder back at the top level", async () => {
		// The one outcome the tree cannot express: the folder reappears, just not
		// where it was, because its parent is gone.
		state.items = [collectionEntry({ parentId: "gone" })];
		restore.mockResolvedValue({
			...collectionEntry(),
			restored: true,
			reparentedToRoot: true,
		});
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Restore Billing" }));

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				expect.objectContaining({ message: expect.stringContaining("top level") })
			)
		);
	});

	it("stays quiet when the restore needed no explaining", async () => {
		state.items = [collectionEntry()];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Restore Billing" }));

		await waitFor(() => expect(restore).toHaveBeenCalled());
		expect(showToast).not.toHaveBeenCalled();
	});

	it("repeats the engine's refusal verbatim, because it names the way out", async () => {
		state.items = [
			collectionEntry({ id: "r1", kind: "request", name: "Charge", parentId: "c1" }),
		];
		restore.mockRejectedValue(
			new Error(
				"Request 'r1' cannot be restored on its own - the collection it belongs to is in the trash, so restore that first"
			)
		);
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Restore Charge" }));

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				expect.stringContaining("restore that first"),
				"error"
			)
		);
	});
});

describe("delete forever", () => {
	it("asks first - this is the delete that cannot be taken back", async () => {
		state.items = [collectionEntry()];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Delete Billing forever" }));

		expect(await screen.findByText("Delete forever?")).toBeInTheDocument();
		expect(purge).not.toHaveBeenCalled();
	});

	it("names what goes with a collection, since the confirm is the last word", async () => {
		state.items = [collectionEntry({ requests: 4 })];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Delete Billing forever" }));

		expect(
			await screen.findByText(/"Billing" and everything inside it will be removed for good/)
		).toBeInTheDocument();
	});

	it("purges once confirmed", async () => {
		state.items = [collectionEntry()];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Delete Billing forever" }));
		fireEvent.click(await screen.findByRole("button", { name: /^Delete forever$/ }));

		await waitFor(() => expect(purge).toHaveBeenCalledWith("c1"));
	});

	it("purges nothing when the dialog is dismissed", async () => {
		state.items = [collectionEntry()];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Delete Billing forever" }));
		fireEvent.click(await screen.findByRole("button", { name: /^Cancel$/ }));

		await waitFor(() => expect(screen.queryByText("Delete forever?")).not.toBeInTheDocument());
		expect(purge).not.toHaveBeenCalled();
	});

	it("reports a failed purge rather than leaving the row silently in place", async () => {
		state.items = [collectionEntry()];
		purge.mockRejectedValue(new Error("database is locked"));
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Delete Billing forever" }));
		fireEvent.click(await screen.findByRole("button", { name: /^Delete forever$/ }));

		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				expect.stringContaining("database is locked"),
				"error"
			)
		);
	});
});
