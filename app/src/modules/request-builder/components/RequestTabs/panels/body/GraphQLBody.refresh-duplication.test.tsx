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
 * Exactly one Refresh-schema control on screen, in every combination of explorer
 * and context-bar state.
 *
 * The rule is #455's and it was guarded by `GraphQLBody.explorer.test.tsx`,
 * which renders `GraphQLBody` alone - so the combination that actually broke it
 * was the one thing that guard could not see: the context bar's GraphQL section
 * is a sibling of `<main>` in the Shell, and its own Refresh stood beside the
 * explorer's whenever both were open (#1224). A rule asserted one component at a
 * time is not asserted at all.
 *
 * The two are composed here rather than through the Shell because the Shell
 * would bring the whole app - routing, queries, the engine client - to answer a
 * question about two subtrees. This is the pair the rule is about.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { fixtureSchema } from "@/test/graphql-schema-fixture";
import { schemaCacheKey, useSchemaCache, type SchemaTarget } from "@/lib/graphql/schema-cache";
import { useExplorerStore } from "@/lib/graphql/explorer-store";
import { useRevealStore } from "@/lib/graphql/reveal-store";
import { useLayoutStore } from "@/stores";
import type { Tab } from "@/stores";
import type { Request } from "@/types";

const requestQuery = vi.fn();
vi.mock("@/queries", () => ({
	useRequestQuery: (id: string | null) => requestQuery(id) as unknown,
}));

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	// Monaco needs a real layout; nothing here asks the editors anything.
	CodeEditor: ({ language }: { language: string }) => <div data-testid={`editor-${language}`} />,
}));

const { GraphQLBody } = await import("./GraphQLBody");
const { GraphQLSection } = await import("@/components/layout/context-bar/GraphQLSection");

const TARGET = {
	url: "https://api.example.com/graphql",
	resolvedUrl: "https://api.example.com/graphql",
	resolvedAuth: null,
} as unknown as SchemaTarget;

const TAB: Tab = { id: "t1", type: "request", entityId: "r1" };

const REQUEST: Partial<Request> = {
	id: "r1",
	url: TARGET.url,
	bodyType: "graphql",
	body: { mode: "graphql", content: JSON.stringify({ query: "query Q { user { id } }" }) },
};

class StubObserver {
	observe() {}
	disconnect() {}
}

/**
 * The body panel and the context bar section on screen together, the way the
 * Shell has them: two subtrees, one schema.
 */
function Composed({ withContextBar }: { withContextBar: boolean }) {
	const [body, setBody] = useState(REQUEST.body?.mode === "graphql" ? REQUEST.body.content : "");
	const [draft, setDraft] = useState<string | null>(null);
	return (
		<TooltipProvider>
			<GraphQLBody
				body={body}
				onBodyChange={setBody}
				requestId="r1"
				schemaTarget={TARGET}
				onEditorMount={() => {}}
				variablesDraft={draft}
				onVariablesDraftChange={setDraft}
			/>
			{withContextBar && <GraphQLSection tab={TAB} />}
		</TooltipProvider>
	);
}

beforeEach(() => {
	vi.stubGlobal("IntersectionObserver", StubObserver);
	requestQuery.mockReturnValue({ data: REQUEST, isLoading: false });
	useRevealStore.setState({ pending: null });
	useLayoutStore.setState({ graphqlVariablesCollapsed: false, graphqlVariablesSize: 35 });
	const key = schemaCacheKey(TARGET);
	useSchemaCache.setState({
		byKey: { [key]: { status: "ready", schema: fixtureSchema(), error: null, fetchedAt: 1 } },
		lru: [key],
		activeKey: key,
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("one Refresh-schema control on screen, in every combination", () => {
	for (const explorerOpen of [false, true]) {
		for (const withContextBar of [false, true]) {
			const state = `explorer ${explorerOpen ? "open" : "closed"}, context bar ${
				withContextBar ? "open" : "closed"
			}`;

			it(`shows exactly one with the ${state}`, () => {
				useExplorerStore.setState({ open: explorerOpen, byKey: {}, lru: [] });
				render(<Composed withContextBar={withContextBar} />);

				// Both subtrees are really drawing their schema half, so the count
				// below is a count and not a section that early-returned "this
				// request does not send a GraphQL body".
				expect(screen.queryByTestId("graphql-explorer") !== null).toBe(explorerOpen);
				expect(screen.queryAllByText("Schema loaded")).toHaveLength(withContextBar ? 1 : 0);

				/*
				 * Mutation check: give the context-bar section its Refresh back, or
				 * the explorer header its own, and the open/open case counts two.
				 * That case is the one that was live before #1224 and the one the
				 * single-component guard could not reach.
				 */
				expect(screen.getAllByLabelText("Refresh schema")).toHaveLength(1);
			});
		}
	}

	it("keeps the one it has in the Query header, not in either pane", () => {
		useExplorerStore.setState({ open: true, byKey: {}, lru: [] });
		render(<Composed withContextBar />);

		const refresh = screen.getByLabelText("Refresh schema");
		// The header the toggle and the status badge sit in - so Refresh is
		// wherever they are, in both states, rather than travelling with the pane.
		expect(refresh.closest("div")).toBe(screen.getByLabelText("Hide schema").closest("div"));
		expect(refresh.closest("[data-testid='graphql-explorer']")).toBeNull();
	});
});
