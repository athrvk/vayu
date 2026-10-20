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
 * The tree rows read everything shared from the collection tree contexts, so a
 * row rendered without the providers has no handlers at all. React's own
 * failure for that is a `TypeError` deep inside the row ("onCollectionClick is
 * not a function", and only once something is clicked) or, worse, a row that
 * renders and silently does nothing. Each context throws instead, naming what is
 * missing, so the mistake is caught at the first render.
 *
 * The `dnd` slot is asserted here for the same reason it exists: phase 3 (#367)
 * mounts the drag machinery into it, and a slot nothing reads is a slot that
 * can quietly disappear before it is used.
 *
 * The split itself (#2543) is asserted as well: each field lives in the context
 * whose change rate suits it, because a field moved into the wrong one is a
 * per-keystroke render of the whole tree that no behavioural test would notice.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import CollectionItem from "./CollectionItem";
import RequestItem from "./RequestItem";
import {
	useCollectionTreeFolderDraft,
	useCollectionTreeHandlers,
	useCollectionTreeState,
} from "./context/CollectionTreeContext";
import { withCollectionTreeContext } from "@/test/collection-tree-context";
import type { Collection, Request } from "@/types";

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

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * React logs the thrown error to the console before it propagates. Silencing it
 * keeps a passing run readable; the assertion below is what proves the throw.
 */
function expectThrowsWithoutProvider(renderRow: () => void) {
	vi.spyOn(console, "error").mockImplementation(() => {});
	expect(renderRow).toThrow(/must be rendered inside CollectionTreeProviders/);
}

describe("collection tree rows require the provider", () => {
	it("throws a readable error when a collection row renders outside it", () => {
		expectThrowsWithoutProvider(() =>
			render(<CollectionItem collection={COLLECTION} depth={0} posInSet={1} setSize={1} />)
		);
	});

	it("throws a readable error when a request row renders outside it", () => {
		expectThrowsWithoutProvider(() =>
			render(<RequestItem request={REQUEST} collectionId="col_1" posInSet={1} setSize={1} />)
		);
	});
});

describe("the handlers context carries the dnd slot", () => {
	it("exposes `dnd` on the handlers, empty until the drag hook mounts into it", () => {
		let seen: ReturnType<typeof useCollectionTreeHandlers> | null = null;
		function Probe() {
			seen = useCollectionTreeHandlers();
			return null;
		}

		render(withCollectionTreeContext(<Probe />));

		// `in`, not a truthiness check: the slot is deliberately null, and the
		// point is that the field is part of the shape rather than absent.
		expect(seen).not.toBeNull();
		expect("dnd" in seen!).toBe(true);
		expect(seen!.dnd).toBeNull();
	});
});

describe("each field lives in the context whose change rate suits it", () => {
	it("keeps functions, tree data and the draft name in three separate contexts", () => {
		let handlers: ReturnType<typeof useCollectionTreeHandlers> | null = null;
		let state: ReturnType<typeof useCollectionTreeState> | null = null;
		let draft: ReturnType<typeof useCollectionTreeFolderDraft> | null = null;
		function Probe() {
			handlers = useCollectionTreeHandlers();
			state = useCollectionTreeState();
			draft = useCollectionTreeFolderDraft();
			return null;
		}

		render(withCollectionTreeContext(<Probe />, { newFolderName: "Typing" }));

		// The draft name changes per keystroke and so is in neither of the others.
		expect(draft).toEqual({ newFolderName: "Typing" });
		expect("newFolderName" in state!).toBe(false);
		expect("newFolderName" in handlers!).toBe(false);
		// Handlers hold functions only (and the dnd slot); data is in the state.
		expect("onFolderNameChange" in handlers!).toBe(true);
		expect("allCollections" in state!).toBe(true);
		expect("allCollections" in handlers!).toBe(false);
		expect("onFolderNameChange" in state!).toBe(false);
	});
});
