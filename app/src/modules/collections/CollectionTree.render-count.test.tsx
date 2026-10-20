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
 * What a row render costs the rest of the tree (#2543).
 *
 * One context value held the new-folder field's text and the drag's drop
 * target, and neither row component was memoised, so every keystroke in the
 * field and every row a drag crossed rebuilt every mounted row. Nothing about
 * that is wrong in a store test or a single-row test: the rows are correct, the
 * tree is just slow. The only way to see it is to count renders of the real
 * tree, which is what this does, through the one hook both row types call on
 * every render (`useRowDnd`).
 *
 * The fixture is 300 requests in one folder: the property is "a render does not
 * scale with the number of mounted rows", and a handful of rows cannot tell a
 * guard that holds from one that renders each of them twice.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useCollectionsStore } from "./collections-store";
import { useTabsStore } from "@/stores";
import type { TreeEntity } from "./drop-position";
import CollectionTree from "./CollectionTree";

const REQUEST_COUNT = 300;
const ROW_HEIGHT = 32;
const FOLDER_ID = "big";

/** Render count by row id, bumped by every row render. */
const rowRenders = vi.hoisted(() => new Map<string, number>());

vi.mock("./tree-row-dnd", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./tree-row-dnd")>();
	return {
		...actual,
		useRowDnd: (entity: TreeEntity) => {
			rowRenders.set(entity.id, (rowRenders.get(entity.id) ?? 0) + 1);
			return actual.useRowDnd(entity);
		},
	};
});

const collections = [
	{ id: FOLDER_ID, name: "Big", order: 0 },
	{ id: "small", name: "Small", order: 1 },
];
const requests = new Map([
	[
		FOLDER_ID,
		Array.from({ length: REQUEST_COUNT }, (_, order) => ({
			id: `r${order}`,
			collectionId: FOLDER_ID,
			name: `Request ${order}`,
			method: "GET",
			order,
		})),
	],
	["small", []],
]);

// Stable function identities, as TanStack hands them out: `mutateAsync` and
// `mutate` are fixed for a mutation's life, while the object around them is new
// on every render - the mocks below return a fresh object each call to match.
const mutateAsync = vi.fn();
const reorderMutate = vi.fn();

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({
		data: collections,
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useMultipleCollectionRequests: () => ({ requestsByCollection: requests }),
	useReorderMutation: () => ({ mutate: reorderMutate, isPending: false }),
	useCreateCollectionMutation: () => ({ mutateAsync, isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync, isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync, isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync, isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync, isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync, isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync, isPending: false }),
	useMockServersQuery: () => ({ data: [] }),
	useStopMockServerMutation: () => ({ mutateAsync, isPending: false }),
}));

function renderTree() {
	return render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

const treeRows = () => Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'));
const rowById = (id: string) =>
	document.querySelector<HTMLElement>(`[data-collection-id="${id}"],[data-request-id="${id}"]`)!;

/** The ids of every row that rendered since the counters were last cleared. */
const renderedIds = () => [...rowRenders.keys()];

/** Open the Big folder's new-subfolder form from its row menu, as a keyboard does. */
async function openNewFolderForm() {
	const row = rowById(FOLDER_ID);
	row.focus();
	fireEvent.keyDown(row, { key: "F10", shiftKey: true });
	fireEvent.click(await screen.findByRole("menuitem", { name: /Add collection/ }));
	return screen.findByPlaceholderText("Collection name");
}

/** jsdom does no layout: rows 32px apart in document order, and a hit test over them. */
function layout() {
	const rows = treeRows();
	rows.forEach((row, index) => {
		row.getBoundingClientRect = () =>
			({
				top: index * ROW_HEIGHT,
				bottom: (index + 1) * ROW_HEIGHT,
				height: ROW_HEIGHT,
				left: 0,
				right: 240,
				width: 240,
				x: 0,
				y: index * ROW_HEIGHT,
				toJSON: () => ({}),
			}) as DOMRect;
	});
	document.elementFromPoint = (_x: number, y: number) => rows[Math.floor(y / ROW_HEIGHT)] ?? null;
	return rows;
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	rowRenders.clear();
	useCollectionsStore.setState({ expandedCollectionIds: new Set([FOLDER_ID]) });
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("typing in the new-folder field", () => {
	// The 300-row fixture is the point of the case - see the file comment.
	it("renders no row but the editing one, however many rows are mounted", async () => {
		renderTree();
		// The fixture really holds what the case claims to measure.
		expect(document.querySelectorAll("[data-request-id]")).toHaveLength(REQUEST_COUNT);
		const mountedRows = treeRows().length;
		expect(mountedRows).toBe(REQUEST_COUNT + collections.length);

		rowRenders.clear();
		const field = await openNewFolderForm();
		// Opening the form is a state change every row may see once: the folder
		// whose form it is, and the rows beside it.
		for (const id of renderedIds()) {
			expect(rowRenders.get(id), `row ${id} after opening the form`).toBeLessThanOrEqual(1);
		}

		rowRenders.clear();
		for (let keystroke = 1; keystroke <= 10; keystroke++) {
			fireEvent.change(field, { target: { value: "n".repeat(keystroke) } });
		}

		expect(field).toHaveValue("nnnnnnnnnn");
		// The form re-renders for each keystroke; the rows, none of them.
		expect(renderedIds()).toEqual([]);
	});
});

describe("a drag crossing rows", () => {
	it("renders only the rows the indicator left and arrived on", () => {
		renderTree();
		expect(document.querySelectorAll("[data-request-id]")).toHaveLength(REQUEST_COUNT);
		const rows = layout();
		const source = rowById("r0");
		const sourceIndex = rows.indexOf(source);
		const yIn = (index: number) => index * ROW_HEIGHT + ROW_HEIGHT * 0.5;

		fireEvent.pointerDown(source, {
			button: 0,
			pointerId: 1,
			clientX: 10,
			clientY: yIn(sourceIndex),
		});
		// One move past the 4px threshold, still over the source row: the drag
		// starts, which every row sees once (`dragging` changed).
		fireEvent.pointerMove(source, {
			pointerId: 1,
			clientX: 10,
			clientY: yIn(sourceIndex) + 6,
		});

		rowRenders.clear();
		const crossed = 10;
		for (let step = 1; step <= crossed; step++) {
			fireEvent.pointerMove(source, {
				pointerId: 1,
				clientX: 10,
				clientY: yIn(sourceIndex + 5 + step),
			});
		}

		// The line left one row and arrived on the next, `crossed` times: at
		// most `crossed + 1` distinct rows ever carried it, and none renders more
		// than twice (arrive, then leave). Nowhere near the 302 mounted rows.
		expect(renderedIds().length).toBeGreaterThan(0);
		expect(renderedIds().length).toBeLessThanOrEqual(crossed + 1);
		for (const id of renderedIds()) {
			expect(rowRenders.get(id), `row ${id} while the drag crossed rows`).toBeLessThanOrEqual(
				2
			);
		}
	});
});
