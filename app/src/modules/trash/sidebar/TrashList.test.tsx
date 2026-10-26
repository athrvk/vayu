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
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { formatInstant } from "@/lib/time-value";
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
		collections: 0,
		requests: 0,
		...over,
	};
}

function exampleEntry(over: Partial<TrashEntry> = {}): TrashEntry {
	return collectionEntry({ id: "x1", kind: "example", name: "Happy path", ...over });
}

function environmentEntry(over: Partial<TrashEntry> = {}): TrashEntry {
	return collectionEntry({
		id: "e1",
		kind: "environment",
		name: "Staging",
		variables: 3,
		...over,
	});
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
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	// A fresh element per render: React skips reconciling a referentially equal
	// one, so a rerender with the same object would show none of the new data.
	const ui = () => (
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<TrashList />
			</TooltipProvider>
		</QueryClientProvider>
	);
	const view = render(ui());

	return {
		...view,
		/** The refetch a purge triggers, which lands after the dialog is gone. */
		refetchWithout(id: string) {
			state.items = state.items.filter((entry) => entry.id !== id);
			act(() => view.rerender(ui()));
		},
	};
}

const rowFor = (id: string) => document.querySelector(`[data-trash-id="${id}"]`);

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
		// The phrase is the platform's, so the expectation asks it rather than spelling it.
		const age = formatInstant(state.items[0].deletedAt, "relative");
		expect(screen.getByText(age)).toBeInTheDocument();
		expect(screen.getByText(/Deleted/)).toBeInTheDocument();
	});

	it("writes the kind out, rather than leaving it to a decorative icon", () => {
		// The glyph is aria-hidden, so without this a screen reader gets a name
		// and a date and no way to tell a deleted folder from a deleted request.
		// Every kind, so a ternary that falls through to one of them fails on
		// the kind it mislabels (#2970, #2971).
		state.items = [
			collectionEntry(),
			collectionEntry({ id: "r1", kind: "request", name: "Charge" }),
			environmentEntry(),
			exampleEntry(),
		];
		renderTrash();

		expect(screen.getByText(/^Collection · Deleted/)).toBeInTheDocument();
		expect(screen.getByText(/^Request · Deleted/)).toBeInTheDocument();
		expect(screen.getByText(/^Environment · Deleted/)).toBeInTheDocument();
		expect(screen.getByText(/^Example · Deleted/)).toBeInTheDocument();
	});

	it("labels an example and draws it with the bookmark, not as a request", () => {
		state.items = [exampleEntry()];
		renderTrash();

		expect(screen.getByText(/^Example · Deleted/)).toBeInTheDocument();
		expect(rowFor("x1")?.querySelector("svg.lucide-bookmark")).not.toBeNull();
		expect(rowFor("x1")?.querySelector("svg.lucide-file-json")).toBeNull();
		// An example takes nothing with it, so the row has no "with ..." tail.
		expect(rowFor("x1")?.textContent).not.toMatch(/with/);
	});

	it("draws an environment with the glyph the Variables view gives one", () => {
		state.items = [environmentEntry()];
		renderTrash();

		expect(rowFor("e1")?.querySelector("svg.lucide-cloud")).not.toBeNull();
		expect(rowFor("e1")?.querySelector("svg.lucide-file-json")).toBeNull();
	});

	it("counts an environment's variables, the one thing it takes with it", () => {
		state.items = [environmentEntry({ variables: 12 })];
		renderTrash();

		expect(screen.getByText(/with 12 variables$/)).toBeInTheDocument();
	});

	it("does not pluralise a single variable, and says nothing for none", () => {
		state.items = [
			environmentEntry({ variables: 1 }),
			environmentEntry({ id: "e2", name: "Empty", variables: 0 }),
		];
		renderTrash();

		expect(screen.getByText(/with 1 variable$/)).toBeInTheDocument();
		expect(rowFor("e2")?.textContent).not.toMatch(/with/);
	});

	it("says what the delete took with it, so a restore's size is visible", () => {
		// A collection in the trash is indistinguishable from an empty one
		// without this - and restoring it is a very different act at 11 requests.
		state.items = [collectionEntry({ collections: 2, requests: 11 })];
		renderTrash();

		expect(screen.getByText(/with 2 collections, 11 requests/)).toBeInTheDocument();
	});

	it("does not pluralise a single child", () => {
		state.items = [collectionEntry({ collections: 1, requests: 1 })];
		renderTrash();

		expect(screen.getByText(/with 1 collection, 1 request$/)).toBeInTheDocument();
	});

	it("states the retention window it read from the engine's config", () => {
		state.items = [collectionEntry()];
		renderTrash();

		expect(
			screen.getByText("Items are permanently deleted 30 days after they land here.")
		).toBeInTheDocument();
	});

	it("claims no window at all when the config has not arrived", () => {
		state.retention = null;
		state.items = [collectionEntry()];
		renderTrash();

		expect(screen.queryByText(/permanently deleted/)).not.toBeInTheDocument();
	});

	it("offers the empty state rather than a bare panel", () => {
		renderTrash();

		expect(screen.getByText("Trash is empty")).toBeInTheDocument();
		// Every kind a delete sends here, environments (#2970) and examples (#2971)
		// included - and the sentence before them is gone.
		expect(
			screen.getByText(/^Deleted collections, requests, environments and examples wait here/)
		).toBeInTheDocument();
		expect(
			screen.queryByText(/^Deleted collections, requests and environments wait here/)
		).not.toBeInTheDocument();
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
	it("restores an environment by its own id, with nothing to explain", async () => {
		state.items = [environmentEntry()];
		restore.mockResolvedValue({
			...environmentEntry(),
			restored: true,
			reparentedToRoot: false,
		});
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Restore Staging" }));

		await waitFor(() => expect(restore).toHaveBeenCalledWith("e1"));
		expect(showToast).not.toHaveBeenCalled();
	});

	it("restores the row it was pressed on", async () => {
		state.items = [collectionEntry()];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Restore Billing" }));

		await waitFor(() => expect(restore).toHaveBeenCalledWith("c1"));
	});

	it("says so when the engine had to put a folder back at the top level", async () => {
		// The one outcome the tree cannot express: the folder reappears, just not
		// where it was, because its parent is gone.
		state.items = [collectionEntry()];
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
		state.items = [collectionEntry({ id: "r1", kind: "request", name: "Charge" })];
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

describe("restoring an example", () => {
	it.each([
		["its request is in the trash", "Request 'r1' is in the trash, so restore that first"],
		[
			"its request already holds the most examples",
			"Request 'r1' already holds the maximum of 100 examples - delete one first",
		],
	])("repeats the engine's 409 verbatim when %s", async (_why, message) => {
		state.items = [exampleEntry()];
		restore.mockRejectedValue(new Error(message));
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Restore Happy path" }));

		await waitFor(() => expect(showToast).toHaveBeenCalledWith(message, "error"));
		expect(restore).toHaveBeenCalledWith("x1");
	});

	it("confirms a purge as a single row, not a cascade", async () => {
		state.items = [exampleEntry()];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Delete Happy path forever" }));

		expect(await screen.findByText('Delete "Happy path" forever?')).toBeInTheDocument();
		expect(screen.queryByText(/and everything inside it/)).not.toBeInTheDocument();
	});
});

describe("delete forever", () => {
	it("asks first - this is the delete that cannot be taken back", async () => {
		state.items = [collectionEntry()];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Delete Billing forever" }));

		expect(await screen.findByText('Delete "Billing" forever?')).toBeInTheDocument();
		expect(purge).not.toHaveBeenCalled();
	});

	it("names what goes with a collection, since the confirm is the last word", async () => {
		state.items = [collectionEntry({ requests: 4 })];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Delete Billing forever" }));

		expect(
			await screen.findByText(/"Billing" and everything inside it is removed permanently/)
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

		await waitFor(() =>
			expect(screen.queryByText('Delete "Billing" forever?')).not.toBeInTheDocument()
		);
		expect(purge).not.toHaveBeenCalled();
	});

	/*
	 * The purged row is where the dialog was opened from, and the dialog is
	 * controlled with no trigger for Radix to restore focus to - so without a
	 * refocus a keyboard "Delete forever" drops the user on `<body>` (#1234).
	 * This dialog closes *before* the purge is sent, so the row is always still
	 * there at close: the move waits for it to go.
	 */
	it("hands focus to the next row once the purged one is gone", async () => {
		state.items = [collectionEntry(), collectionEntry({ id: "c2", name: "Shipping" })];
		const view = renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Delete Billing forever" }));
		fireEvent.click(await screen.findByRole("button", { name: /^Delete forever$/ }));

		await waitFor(() => expect(purge).toHaveBeenCalledWith("c1"));
		expect(document.activeElement).toBe(rowFor("c1"));

		view.refetchWithout("c1");

		expect(document.activeElement).toBe(rowFor("c2"));
	});

	it("falls back to the row before it when the purged row was the last", async () => {
		state.items = [collectionEntry(), collectionEntry({ id: "c2", name: "Shipping" })];
		const view = renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Delete Shipping forever" }));
		fireEvent.click(await screen.findByRole("button", { name: /^Delete forever$/ }));

		await waitFor(() => expect(purge).toHaveBeenCalledWith("c2"));
		view.refetchWithout("c2");

		expect(document.activeElement).toBe(rowFor("c1"));
	});

	it("falls back to the list when the purged row was the only one", async () => {
		state.items = [collectionEntry()];
		const view = renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Delete Billing forever" }));
		fireEvent.click(await screen.findByRole("button", { name: /^Delete forever$/ }));

		await waitFor(() => expect(purge).toHaveBeenCalledWith("c1"));
		view.refetchWithout("c1");

		// Neither a next nor a previous row is left, and Trash has no create
		// control to hand focus to the way the trees do - so it goes to the list
		// itself, which is still there holding the empty state. Never `<body>`.
		const list = document.querySelector<HTMLElement>("[data-trash-list]");
		expect(document.activeElement).toBe(list);
	});

	it("leaves focus on the row when the purge fails", async () => {
		state.items = [collectionEntry(), collectionEntry({ id: "c2", name: "Shipping" })];
		purge.mockRejectedValue(new Error("database is locked"));
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Delete Billing forever" }));
		fireEvent.click(await screen.findByRole("button", { name: /^Delete forever$/ }));

		await waitFor(() => expect(showToast).toHaveBeenCalled());
		// The row is still there, so it is still where the user was.
		expect(document.activeElement).toBe(rowFor("c1"));
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

// Issue #1689: the panel-header counterpart to per-row purge. No bulk engine
// route exists, so this loops the same per-row mutation over every listed
// entry - confirmed once, the way the per-row purge is.
describe("empty trash", () => {
	it("asks first, and purges nothing until confirmed", async () => {
		state.items = [
			collectionEntry(),
			collectionEntry({ id: "c2", name: "Auth", kind: "request" }),
		];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));

		expect(await screen.findByText("Empty trash?")).toBeInTheDocument();
		expect(purge).not.toHaveBeenCalled();
	});

	it.each([
		[1, "The one item in the trash is removed permanently. This can't be undone."],
		[2, "All 2 items in the trash are removed permanently. This can't be undone."],
	])("agrees the verb with a count of %i", async (count, sentence) => {
		state.items = [
			collectionEntry(),
			collectionEntry({ id: "c2", name: "Auth", kind: "request" }),
		].slice(0, count);
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));

		expect(await screen.findByRole("dialog")).toHaveTextContent(sentence);
	});

	it("purges every row once confirmed", async () => {
		state.items = [
			collectionEntry(),
			collectionEntry({ id: "c2", name: "Auth", kind: "request" }),
		];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
		fireEvent.click(await screen.findByRole("button", { name: /^Empty trash$/ }));

		await waitFor(() => expect(purge).toHaveBeenCalledWith("c1"));
		await waitFor(() => expect(purge).toHaveBeenCalledWith("c2"));
		expect(purge).toHaveBeenCalledTimes(2);
	});

	it("purges nothing when the dialog is dismissed", async () => {
		state.items = [collectionEntry()];
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
		fireEvent.click(await screen.findByRole("button", { name: /^Cancel$/ }));

		await waitFor(() => expect(screen.queryByText("Empty trash?")).not.toBeInTheDocument());
		expect(purge).not.toHaveBeenCalled();
	});

	it("reports a row that fails without stopping the rest", async () => {
		state.items = [
			collectionEntry(),
			collectionEntry({ id: "c2", name: "Auth", kind: "request" }),
		];
		purge
			.mockRejectedValueOnce(new Error("database is locked"))
			.mockResolvedValueOnce({ ...collectionEntry(), purged: true });
		renderTrash();

		fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
		fireEvent.click(await screen.findByRole("button", { name: /^Empty trash$/ }));

		await waitFor(() => expect(purge).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(expect.stringContaining("1 of 2"), "error")
		);
	});
});
