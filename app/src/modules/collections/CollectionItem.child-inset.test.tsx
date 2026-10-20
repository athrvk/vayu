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
 * One level shows one left edge.
 *
 * Rows derive their indent from their depth; everything else under a folder
 * used to carry a fixed `px-*`, so a nested folder's "Empty folder" line sat
 * at the tree's left edge - left of its own parent's label and left of the
 * sibling request rows below it (#1372). The new-subfolder form had the same
 * defect one step further left.
 *
 * The guard is an equality rather than a number: the placeholder and the form
 * are compared against the `paddingLeft` a `RequestItem` actually renders at
 * `depth + 1`, which is the row they stand in for. A fix that moved only one of
 * the two, or that moved both to some other constant, fails here. The formula
 * is asserted as well, from `INDENT_STEP`, so the pair cannot drift together.
 *
 * jsdom has no layout, so this reads the inline `style` the component sets, not
 * a computed box.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CollectionItem from "./CollectionItem";
import CollectionTreeRows from "./CollectionTreeRows";
import RequestItem from "./RequestItem";
import { flattenVisibleRows } from "./tree-rows";
import {
	withCollectionTreeContext,
	type CollectionTreeTestValue,
} from "@/test/collection-tree-context";
import { INDENT_STEP } from "@/constants/layout";
import type { Collection, Request } from "@/types";

vi.mock("@/queries", () => ({
	useReorderMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

const COLLECTION: Collection = {
	id: "col_1",
	name: "Acme API",
	description: "",
	order: 0,
	variables: {},
	auth: { mode: "none" },
	elements: [],
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

const REQUEST: Request = {
	id: "req_1",
	collectionId: "col_1",
	name: "Get user",
	description: "",
	method: "GET",
	url: "https://api.test/user",
	params: [],
	headers: [],
	body: { mode: "none" },
	bodyType: "none",
	auth: { mode: "none" },
	elements: [],
	followRedirects: true,
	maxRedirects: 10,
	verifySSL: true,
	disableCookies: false,
	disabledSystemHeaders: [],
	disableUrlEncoding: false,
	httpVersion: "auto",
	stream: false,
	mockResponseMode: "first",
	order: 0,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

/**
 * `COLLECTION` at `depth`, under a chain of expanded ancestors, as the tree
 * lists it: the folder row is followed by the rows that stand in for its
 * children, which are rows of their own rather than markup inside the folder's.
 */
function renderFolderRows(depth: number, overrides: Partial<CollectionTreeTestValue> = {}) {
	const ancestors = Array.from({ length: depth }, (_, level) => ({
		...COLLECTION,
		id: `ancestor_${level}`,
		name: `Ancestor ${level}`,
		parentId: level === 0 ? undefined : `ancestor_${level - 1}`,
	}));
	const folder = { ...COLLECTION, parentId: depth === 0 ? undefined : `ancestor_${depth - 1}` };
	const collections = [...ancestors, folder];
	const expandedCollectionIds = new Set(collections.map((c) => c.id));
	const getRequestsByCollection = overrides.getRequestsByCollection ?? (() => []);
	const creatingSubfolder = overrides.creatingSubfolder ?? null;
	const rows = flattenVisibleRows({
		collections,
		getRequestsByCollection,
		expandedCollectionIds,
		creatingSubfolder,
	});
	const view = render(
		withCollectionTreeContext(<CollectionTreeRows rows={rows} />, {
			allCollections: collections,
			expandedCollectionIds,
			getRequestsByCollection,
			creatingSubfolder,
		})
	);
	const row = view.container.querySelector<HTMLElement>(
		`[data-collection-id="${COLLECTION.id}"]`
	)!;
	expect(row).toHaveAttribute("aria-level", String(depth + 1));
	return { ...view, row };
}

/** The expanded, empty folder at `depth`, with nothing being created. */
function renderEmptyFolder(depth: number) {
	return renderFolderRows(depth);
}

/** What a child row of that folder actually indents to. */
function childRowPaddingLeft(depth: number): string {
	const { container, unmount } = render(
		withCollectionTreeContext(
			<RequestItem
				request={REQUEST}
				collectionId={COLLECTION.id}
				depth={depth + 1}
				posInSet={1}
				setSize={1}
			/>
		)
	);
	const row = container.querySelector('[role="treeitem"]') as HTMLElement;
	const padding = row.style.paddingLeft;
	unmount();
	return padding;
}

describe.each([0, 2])("a folder at depth %i", (depth) => {
	const expected = `${8 + (depth + 1) * INDENT_STEP}px`;

	it("starts its 'Empty collection' line where a request row starts", () => {
		renderEmptyFolder(depth);

		const placeholder = screen.getByText("Empty collection");
		expect(placeholder.style.paddingLeft).toBe(expected);
		expect(placeholder.style.paddingLeft).toBe(childRowPaddingLeft(depth));
	});

	it("starts the new-subfolder form at that same edge", () => {
		renderFolderRows(depth, { creatingSubfolder: COLLECTION.id });

		const form = screen.getByPlaceholderText("Collection name").closest("div") as HTMLElement;
		expect(form.style.paddingLeft).toBe(expected);
		expect(form.style.paddingLeft).toBe(childRowPaddingLeft(depth));
	});
});

describe("a folder's rename field", () => {
	// `Input`'s xs geometry is drawn for this row's `gap-2`: pulled back by its
	// padding plus its border, the field's text lands on the label's x and its
	// border clears the folder by a step. An override here would be a second
	// geometry for one field.
	it("takes xs's geometry, beside the folder at the gap xs is drawn for", () => {
		render(
			withCollectionTreeContext(
				<CollectionItem collection={COLLECTION} depth={0} posInSet={1} setSize={1} />,
				{ allCollections: [COLLECTION], renamingId: COLLECTION.id }
			)
		);

		const input = screen.getByDisplayValue(COLLECTION.name);
		const list = input.className.split(/\s+/);
		expect(list).toContain("px-1");
		expect(list).toContain("-ml-[calc(var(--spacing)*1+1px)]");
		expect(input.parentElement?.className).toMatch(/\bgap-2\b/);
	});
});

describe("an empty folder's row", () => {
	it("describes itself as empty, since nothing under it is a treeitem to find", () => {
		const { row } = renderEmptyFolder(1);

		const describedBy = row.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		expect(document.getElementById(describedBy as string)?.textContent).toBe(
			"Empty collection"
		);
	});

	it("drops the description once the folder has a row to announce", () => {
		const { row } = renderFolderRows(1, {
			getRequestsByCollection: (id) => (id === COLLECTION.id ? [REQUEST] : []),
		});

		expect(screen.getByText(REQUEST.name)).toBeInTheDocument();
		expect(row.getAttribute("aria-describedby")).toBeNull();
		expect(screen.queryByText("Empty collection")).not.toBeInTheDocument();
	});
});
