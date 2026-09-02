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
 * The bar's GraphQL section: status, freshness, and the document's outline.
 *
 * The section applies to every request tab, because `appliesTo` sees only the
 * tab - so the first case here is the one that keeps it from being noise on a
 * REST request, and it is the case a narrowing of `appliesTo` would delete.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { fixtureSchema } from "@/test/graphql-schema-fixture";
import { useSchemaCache, type SchemaTarget } from "@/lib/graphql/schema-cache";
import { useRevealStore } from "@/lib/graphql/reveal-store";
import type { Tab } from "@/stores";
import type { Request } from "@/types";

const requestQuery = vi.fn();
vi.mock("@/queries", () => ({
	useRequestQuery: (id: string | null) => requestQuery(id) as unknown,
}));

const { GraphQLSection } = await import("./GraphQLSection");

const TAB: Tab = { id: "t1", type: "request", entityId: "r1" };

const TARGET = {
	url: "https://api.example.com/graphql",
	resolvedUrl: "https://api.example.com/graphql",
	resolvedAuth: null,
} as unknown as SchemaTarget;

function graphqlRequest(content: string): Partial<Request> {
	return {
		id: "r1",
		url: "https://api.example.com/graphql",
		bodyType: "graphql",
		body: { mode: "graphql", content },
	};
}

function show(request: Partial<Request> | undefined, isLoading = false) {
	requestQuery.mockReturnValue({ data: request, isLoading });
	render(
		<TooltipProvider>
			<GraphQLSection tab={TAB} />
		</TooltipProvider>
	);
}

beforeEach(() => {
	useSchemaCache.setState({ byKey: {}, lru: [], activeKey: null });
	useRevealStore.setState({ pending: null });
	requestQuery.mockReset();
});

afterEach(cleanup);

describe("when the request is not GraphQL", () => {
	it("says so instead of showing an empty outline", () => {
		show({ id: "r1", bodyType: "json", body: { mode: "json", content: "{}" } });
		expect(screen.getByText(/does not send a GraphQL body/)).toBeTruthy();
	});

	it("says so while the request is still loading, rather than guessing", () => {
		show(undefined, true);
		expect(screen.getByText("Loading…")).toBeTruthy();
	});
});

describe("the schema status", () => {
	it("reports that nothing has been introspected yet", () => {
		show(graphqlRequest(JSON.stringify({ query: "" })));
		expect(screen.getByText(/Schema not loaded/)).toBeTruthy();
	});

	it("reports a loaded schema with its age", () => {
		const key = "k";
		useSchemaCache.setState({
			byKey: {
				[key]: {
					status: "ready",
					schema: fixtureSchema(),
					error: null,
					fetchedAt: Date.now(),
				},
			},
			lru: [key],
			activeKey: key,
		});
		show(graphqlRequest(JSON.stringify({ query: "" })));

		expect(screen.getByText(/Schema loaded/)).toBeTruthy();
		expect(screen.getByText(/Fetched/)).toBeTruthy();
	});

	it("keeps the age of a schema whose refresh failed, and names the failure", () => {
		const key = "k";
		useSchemaCache.setState({
			byKey: {
				[key]: {
					status: "error",
					schema: fixtureSchema(),
					error: { kind: "auth", message: "401 Unauthorized" },
					fetchedAt: Date.now() - 60_000,
				},
			},
			lru: [key],
			activeKey: key,
		});
		show(graphqlRequest(JSON.stringify({ query: "" })));

		expect(screen.getByText(/Schema failed/)).toBeTruthy();
		expect(screen.getByText("401 Unauthorized")).toBeTruthy();
		expect(screen.getByText(/Fetched/)).toBeTruthy();
	});

	/*
	 * The bar states the schema; it does not refresh it. Its Refresh was the
	 * second standing one whenever the body panel was on screen with this bar
	 * open - the duplication #455 was filed about, in the one combination its
	 * guard could not see, since that guard renders `GraphQLBody` alone (#1224).
	 *
	 * It could never be the only one either: the button was gated on the store's
	 * `activeTarget`, which `GraphQLBody` alone set - and only for a non-empty
	 * URL - and cleared when it unmounted. So it stood exactly when the Query
	 * header's own control stood beside it, and never when it did not. The field
	 * went with the button, since nothing else read it.
	 *
	 * Registered here anyway, so this is not passing on an unregistered target:
	 * mutation check - put the button back and this reds.
	 */
	it("offers no refresh at all - the Query header owns the only one", () => {
		useSchemaCache.getState().setActiveTarget(TARGET);
		show(graphqlRequest(JSON.stringify({ query: "" })));
		expect(useSchemaCache.getState().activeKey).not.toBeNull();
		expect(screen.queryByLabelText("Refresh schema")).toBeNull();
	});
});

describe("the outline", () => {
	it("lists each operation with its kind", () => {
		const query = 'query Users { user(id: "1") { id } }\nmutation Add { deletePost(id: "1") }';
		show(graphqlRequest(JSON.stringify({ query })));

		expect(screen.getByText("2 operations")).toBeTruthy();
		expect(screen.getByText("Users")).toBeTruthy();
		expect(screen.getByText("Add")).toBeTruthy();
		expect(screen.getByText("mutation")).toBeTruthy();
	});

	it("shows the shorthand document rather than nothing", () => {
		show(graphqlRequest(JSON.stringify({ query: '{ user(id: "1") { id } }' })));
		expect(screen.getByText("1 operation")).toBeTruthy();
		expect(screen.getByText("(anonymous)")).toBeTruthy();
	});

	it("says nothing is defined while the document is mid-edit", () => {
		show(graphqlRequest(JSON.stringify({ query: "query Broken { user(" })));
		expect(screen.getByText(/No operation in this document/)).toBeTruthy();
	});
});

/*
 * The rows were plain `<li>` text. What they write is a command for the query
 * editor, which lives in another module - `GraphQLBody.reveal.test.tsx` is the
 * other half of this.
 */
describe("clicking an operation", () => {
	const TWO = 'query Users { user(id: "1") { id } }\nmutation Add { deletePost(id: "1") }';

	it("asks the editor to scroll to that operation, naming the request", () => {
		show(graphqlRequest(JSON.stringify({ query: TWO })));

		fireEvent.click(screen.getByLabelText("Go to mutation Add in the editor"));
		expect(useRevealStore.getState().pending).toEqual({
			requestId: "r1",
			name: "Add",
			index: 1,
		});
	});

	it("names the anonymous operation by its position, since it has no name", () => {
		show(graphqlRequest(JSON.stringify({ query: '{ user(id: "1") { id } }' })));

		fireEvent.click(screen.getByLabelText("Go to query (anonymous) in the editor"));
		expect(useRevealStore.getState().pending).toEqual({
			requestId: "r1",
			name: null,
			index: 0,
		});
	});

	// Mutation check: turn the row back into an `<li>` with an onClick and this
	// reddens - the keyboard-only user is who loses the feature that way.
	it("is a button, so Enter and Space reach it", () => {
		show(graphqlRequest(JSON.stringify({ query: TWO })));
		const row = screen.getByLabelText("Go to query Users in the editor");
		expect(row.tagName).toBe("BUTTON");
	});
});
