/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A draft's sub-folders and requests as the one sibling list they become
 * (issue #2535).
 *
 * A parsed collection keeps its two kinds in two arrays, `children` and
 * `requests`; stored, they share one `order` space and the sidebar and a
 * recursive run read them merged. A draft's own `order` places it (a Postman
 * item's or a JMeter element's document position, a Vayu-written document's
 * stored order); a draft that states none keeps the listing the other
 * importers produce, its
 * folders first and its requests after them. On a tie a folder comes first,
 * the stored tree's rule, then list position.
 *
 * The engine's `sibling_positions` (`import_document.cpp`) is the other copy;
 * `import-conformance.json`'s payloads pin the two together.
 */

import type { CollectionDraft, RequestDraft } from "./types";

type Parent = Pick<CollectionDraft, "children" | "requests">;

/** Each child's position in its parent's sibling list, dense from 0. */
export interface SiblingPositions {
	folders: number[];
	requests: number[];
}

export type DraftSibling =
	{ kind: "folder"; draft: CollectionDraft } | { kind: "request"; draft: RequestDraft };

const FOLDER_RANK = 0;
const REQUEST_RANK = 1;

export function siblingPositions(parent: Parent): SiblingPositions {
	const folderCount = parent.children.length;
	const entries = [
		...parent.children.map((draft, index) => ({
			order: draft.order ?? index,
			rank: FOLDER_RANK,
			index,
		})),
		...parent.requests.map((draft, index) => ({
			order: draft.order ?? folderCount + index,
			rank: REQUEST_RANK,
			index,
		})),
	];
	entries.sort((a, b) => a.order - b.order || a.rank - b.rank || a.index - b.index);

	const positions: SiblingPositions = {
		folders: new Array<number>(folderCount),
		requests: new Array<number>(parent.requests.length),
	};
	entries.forEach((entry, position) => {
		const slots = entry.rank === FOLDER_RANK ? positions.folders : positions.requests;
		slots[entry.index] = position;
	});
	return positions;
}

/** The sub-folders and requests in the order the sidebar will list them. */
export function draftSiblings(parent: Parent): DraftSibling[] {
	const positions = siblingPositions(parent);
	const listed = new Array<DraftSibling>(parent.children.length + parent.requests.length);
	parent.children.forEach((draft, index) => {
		listed[positions.folders[index]] = { kind: "folder", draft };
	});
	parent.requests.forEach((draft, index) => {
		listed[positions.requests[index]] = { kind: "request", draft };
	});
	return listed;
}
