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
 * The tree rows read everything shared from `CollectionTreeContext`, so a row
 * rendered without a provider has no handlers at all. React's own failure for
 * that is a `TypeError` deep inside the row ("onCollectionClick is not a
 * function", and only once something is clicked) or, worse, a row that renders
 * and silently does nothing. The context throws instead, naming what is
 * missing, so the mistake is caught at the first render.
 *
 * The `dnd` slot is asserted here for the same reason it exists: phase 3 (#367)
 * mounts the drag machinery into it, and a slot nothing reads is a slot that
 * can quietly disappear before it is used.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import CollectionItem from "./CollectionItem";
import RequestItem from "./RequestItem";
import { useCollectionTreeContext } from "./context/CollectionTreeContext";
import { withCollectionTreeContext } from "@/test/collection-tree-context";
import type { Collection, Request } from "@/types";

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
	httpVersion: "auto",
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
	expect(renderRow).toThrow(/must be rendered inside CollectionTreeContext.Provider/);
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

describe("the context carries the phase-3 dnd slot", () => {
	it("exposes `dnd`, empty until the drag hook mounts into it", () => {
		let seen: ReturnType<typeof useCollectionTreeContext> | null = null;
		function Probe() {
			seen = useCollectionTreeContext();
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
