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
 * Rows derive their indent from their depth; everything else inside a folder's
 * `role="group"` used to carry a fixed `px-*`, so a nested folder's "Empty
 * folder" line sat at the tree's left edge - left of its own parent's label and
 * left of the sibling request rows below it (#1372). The new-subfolder form had
 * the same defect one step further left.
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
import RequestItem from "./RequestItem";
import { withCollectionTreeContext } from "@/test/collection-tree-context";
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
	preRequestScript: "",
	postRequestScript: "",
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
	preRequestScript: "",
	postRequestScript: "",
	followRedirects: true,
	maxRedirects: 10,
	verifySSL: true,
	httpVersion: "auto",
	stream: false,
	order: 0,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
};

/** The expanded, empty folder at `depth`, with nothing being created. */
function renderEmptyFolder(depth: number) {
	return render(
		withCollectionTreeContext(
			<CollectionItem collection={COLLECTION} depth={depth} posInSet={1} setSize={1} />,
			{
				allCollections: [COLLECTION],
				expandedCollectionIds: new Set([COLLECTION.id]),
			}
		)
	);
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

	it("starts its 'Empty folder' line where a request row starts", () => {
		renderEmptyFolder(depth);

		const placeholder = screen.getByText("Empty folder");
		expect(placeholder.style.paddingLeft).toBe(expected);
		expect(placeholder.style.paddingLeft).toBe(childRowPaddingLeft(depth));
	});

	it("starts the new-subfolder form at that same edge", () => {
		render(
			withCollectionTreeContext(
				<CollectionItem collection={COLLECTION} depth={depth} posInSet={1} setSize={1} />,
				{
					allCollections: [COLLECTION],
					expandedCollectionIds: new Set([COLLECTION.id]),
					creatingSubfolder: COLLECTION.id,
				}
			)
		);

		const form = screen.getByPlaceholderText("Folder name").closest("div") as HTMLElement;
		expect(form.style.paddingLeft).toBe(expected);
		expect(form.style.paddingLeft).toBe(childRowPaddingLeft(depth));
	});
});

describe("an empty folder's row", () => {
	it("describes itself as empty, since its group holds no treeitem to find", () => {
		const { container } = renderEmptyFolder(1);

		const row = container.querySelector('[role="treeitem"]') as HTMLElement;
		const describedBy = row.getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		expect(document.getElementById(describedBy as string)?.textContent).toBe("Empty folder");
	});

	it("drops the description once the folder has a row to announce", () => {
		const { container } = render(
			withCollectionTreeContext(
				<CollectionItem collection={COLLECTION} depth={1} posInSet={1} setSize={1} />,
				{
					allCollections: [COLLECTION],
					expandedCollectionIds: new Set([COLLECTION.id]),
					getRequestsByCollection: () => [REQUEST],
				}
			)
		);

		const row = container.querySelector('[role="treeitem"]') as HTMLElement;
		expect(row.getAttribute("aria-describedby")).toBeNull();
		expect(screen.queryByText("Empty folder")).not.toBeInTheDocument();
	});
});
