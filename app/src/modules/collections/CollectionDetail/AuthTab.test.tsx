/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Two things this tab used to get wrong, both of them silent.
 *
 * 1. A collection whose stored auth is oauth2/digest/aws/ntlm was narrowed to
 *    "none" for display. The tab then said "No authentication for this
 *    collection. Requests using 'Inherit from collection' will send no auth."
 *    about a collection that does have auth — while the inheritance chain three
 *    lines below it said OAUTH2. A Postman import produces exactly this
 *    (services/importers/postman.ts `collectionAuth` passes oauth2 through).
 *
 * 2. A rejected save rendered nothing at all. There is no global
 *    MutationCache.onError, and no tab read `isError`, so the button just went
 *    from "Saving…" back to "Save Auth".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Collection } from "@/types";
import AuthTab from "./AuthTab";

const mutation = {
	mutate: vi.fn(),
	reset: vi.fn(),
	isPending: false,
	isError: false,
	error: null as Error | null,
};

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => mutation,
	// InheritanceChain renders nothing for an empty chain, which keeps this
	// file about the tab itself.
	useCollectionAncestors: () => [],
}));

function makeCollection(auth: Collection["auth"]): Collection {
	return {
		id: "c1",
		name: "Acme API",
		description: "",
		order: 0,
		variables: {},
		auth,
		preRequestScript: "",
		postRequestScript: "",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

beforeEach(() => {
	mutation.mutate.mockReset();
	mutation.reset.mockReset();
	mutation.isPending = false;
	mutation.isError = false;
	mutation.error = null;
});

describe("AuthTab with an auth mode it cannot edit", () => {
	const oauth2 = makeCollection({
		mode: "oauth2",
		config: {
			grantType: "client_credentials",
			accessTokenUrl: "https://idp.example/token",
			clientId: "acme-web",
		},
	});

	it("does not tell the user there is no auth", () => {
		render(<AuthTab collection={oauth2} />);

		expect(
			screen.queryByText(/No authentication for this collection/i)
		).not.toBeInTheDocument();
		// The hint under the type picker is driven by the same narrowing, so it
		// is the second half of the same claim.
		expect(
			screen.queryByText(/Requests use no authentication unless they set their own/i)
		).not.toBeInTheDocument();
	});

	it("names the mode that is actually stored, and says what changing it costs", () => {
		render(<AuthTab collection={oauth2} />);

		expect(screen.getByText(/OAuth 2\.0 auth is set/i)).toBeInTheDocument();
		expect(screen.getByText(/Picking a type below replaces it/i)).toBeInTheDocument();
		expect(screen.getByText(/OAuth 2\.0 \(not editable here\)/i)).toBeInTheDocument();
	});
});

describe("AuthTab with an editable auth mode", () => {
	it("still renders the editor for a mode it does understand", () => {
		render(<AuthTab collection={makeCollection({ mode: "bearer", token: "abc" })} />);

		expect(screen.getByPlaceholderText(/Bearer token or/i)).toBeInTheDocument();
		expect(screen.queryByText(/not editable here/i)).not.toBeInTheDocument();
	});

	it("says no auth when there genuinely is none", () => {
		render(<AuthTab collection={makeCollection({ mode: "none" })} />);

		expect(screen.getByText(/No authentication for this collection/i)).toBeInTheDocument();
	});
});

describe("AuthTab when the save fails", () => {
	it("surfaces the rejection instead of quietly re-enabling the button", () => {
		mutation.isError = true;
		mutation.error = new Error("database is locked");
		render(<AuthTab collection={makeCollection({ mode: "bearer", token: "abc" })} />);

		expect(screen.getByText(/Couldn't save auth/i)).toBeInTheDocument();
		expect(screen.getByText(/database is locked/i)).toBeInTheDocument();
	});

	it("says nothing when the save has not failed", () => {
		render(<AuthTab collection={makeCollection({ mode: "bearer", token: "abc" })} />);
		expect(screen.queryByText(/Couldn't save/i)).not.toBeInTheDocument();
	});

	/**
	 * Shell renders <CollectionDetail /> with no key, and this tab's own comments
	 * say it is not remounted per collection — that is why the draft resync
	 * effect exists. The mutation is reused the same way and holds `isError`
	 * until the next mutate, so without clearing it the notice would follow the
	 * user to a collection they never tried to save.
	 */
	it("clears the failure when a different collection arrives", () => {
		const { rerender } = render(
			<AuthTab collection={makeCollection({ mode: "bearer", token: "abc" })} />
		);
		expect(mutation.reset).toHaveBeenCalledTimes(1);

		// Same collection, new props: not a switch, so nothing to clear.
		const renamed = { ...makeCollection({ mode: "bearer", token: "abc" }), name: "Renamed" };
		rerender(<AuthTab collection={renamed} />);
		expect(mutation.reset).toHaveBeenCalledTimes(1);

		const other = { ...makeCollection({ mode: "bearer", token: "xyz" }), id: "c2" };
		rerender(<AuthTab collection={other} />);
		expect(mutation.reset).toHaveBeenCalledTimes(2);
	});
});
