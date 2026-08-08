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
 * What a collection hands down, and to whom.
 *
 * The four answers below are genuinely different outcomes, and the one worth
 * the section is the third: a collection that configures nothing does not mean
 * "no auth" - a request under it inherits from further up, and naming that
 * ancestor is the difference between a five-minute 401 and an afternoon one.
 *
 * The walk is `resolveAuthSource`, shared with the Auth tab's chain and with
 * what is actually sent. Mutation-check: answer from `collection.auth` alone
 * and the inheriting cases redden.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { CollectionAuthSection } from "./CollectionAuthSection";
import type { Collection, RequestAuth } from "@/types";

let collections: Collection[] = [];

vi.mock("@/queries", async () => {
	const { walkAncestors } = await vi.importActual<
		typeof import("@/modules/collections/tree-utils")
	>("@/modules/collections/tree-utils");
	return {
		useCollectionsQuery: () => ({ data: collections, isLoading: false }),
		// The real hook is `walkAncestors` over the same list - kept rather than
		// stubbed so the chain this section reasons about is a real chain.
		useCollectionAncestors: (id: string | null) => (id ? walkAncestors(id, collections) : []),
	};
});

const TAB = { id: "t1", type: "collection", entityId: "col_leaf" } as const;

const collection = (
	id: string,
	auth: Collection["auth"],
	parentId?: string,
	name = id
): Collection => ({
	id,
	name,
	description: "",
	order: 0,
	variables: {},
	auth,
	preRequestScript: "",
	postRequestScript: "",
	createdAt: "",
	updatedAt: "",
	...(parentId ? { parentId } : {}),
});

const bearer: Exclude<RequestAuth, { mode: "inherit" }> = { mode: "bearer", token: "t" };

beforeEach(() => {
	collections = [];
});

describe("CollectionAuthSection", () => {
	it("names the auth this collection configures", () => {
		collections = [collection("col_leaf", bearer)];
		render(<CollectionAuthSection tab={TAB} />);

		expect(screen.getByText("Bearer Token")).toBeInTheDocument();
		expect(screen.getByText("Requests set to Inherit send this.")).toBeInTheDocument();
	});

	it("names the ancestor a request under it would inherit from instead", () => {
		collections = [
			collection("col_root", bearer, undefined, "Billing"),
			collection("col_leaf", { mode: "none" }, "col_root"),
		];
		render(<CollectionAuthSection tab={TAB} />);

		expect(
			screen.getByText("Requests below inherit Bearer Token from Billing.")
		).toBeInTheDocument();
	});

	it("says which ancestor blocks inheriting rather than implying nobody set any", () => {
		collections = [
			collection("col_root", bearer, undefined, "Billing"),
			collection("col_mid", { mode: "noauth" }, "col_root", "Sandbox"),
			collection("col_leaf", { mode: "none" }, "col_mid"),
		];
		render(<CollectionAuthSection tab={TAB} />);

		expect(
			screen.getByText("Sandbox is set to No Auth, so nothing is inherited past it.")
		).toBeInTheDocument();
	});

	it("says the walk stops here when this collection is the blocker", () => {
		collections = [
			collection("col_root", bearer, undefined, "Billing"),
			collection("col_leaf", { mode: "noauth" }, "col_root"),
		];
		render(<CollectionAuthSection tab={TAB} />);

		expect(screen.getByText("No Auth (blocks inheriting)")).toBeInTheDocument();
		expect(
			screen.getByText("Requests below inherit nothing - the walk stops here.")
		).toBeInTheDocument();
	});

	it("says so when nothing in the chain defines auth", () => {
		collections = [collection("col_leaf", { mode: "none" })];
		render(<CollectionAuthSection tab={TAB} />);

		expect(screen.getByText("No ancestor collection defines auth either.")).toBeInTheDocument();
	});

	it("says the collection is gone rather than reporting No Auth for it", () => {
		collections = [collection("col_other", bearer)];
		render(<CollectionAuthSection tab={TAB} />);

		expect(screen.getByText("This collection is no longer available")).toBeInTheDocument();
	});
});
