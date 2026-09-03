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
 * What each section reports about the request in front of it.
 *
 * The bar's half of this - hidden draws nothing, empty draws a header with no
 * way in - is `ContextBar.relevance.test.tsx`. This file is the sections' half:
 * the verdict each one reaches from its own data, which is the part that decides
 * whether a user opening a plain REST request sees two useful sections or seven
 * headers to scan past (#1310).
 *
 * The three-way distinction is the thing to hold on to while reading these
 * cases. `hidden` is "this does not apply to this request" - showing the title
 * would be a line about something the user is not doing. `empty` is "this
 * applies and the answer is nothing", which is an answer worth a word.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
	useCookiesRelevance,
	useGraphQLRelevance,
	useRecentSendsRelevance,
	useVariablesRelevance,
} from "./relevance";
import type { EngineCookie, GetCookiesResponse, ResolvedVariable } from "@/types";
import type { Tab } from "@/stores";

/* ── The data each hook reads, as mutable fixtures ───────────────────────── */

let request: Record<string, unknown> | undefined;
let cookiesData: GetCookiesResponse | undefined;
let cookiesLoading = false;
let runs: unknown[] | undefined;
let runsLoading = false;
let inScope: Record<string, ResolvedVariable>;

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: request, isLoading: request === undefined }),
	useCollectionAncestors: () => [],
	useRecentDesignRunsQuery: () => ({
		data: runs === undefined ? undefined : { data: runs },
		isLoading: runsLoading,
	}),
}));

vi.mock("@/queries/cookies", () => ({
	useCookiesQuery: () => ({ data: cookiesData, isLoading: cookiesLoading }),
}));

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		getVariable: (name: string) => inScope[name] ?? null,
		getAllVariables: () => ({ ...inScope }),
	}),
}));

vi.mock("@/stores", () => ({
	useSessionStore: (selector: (s: { activeEnvironmentId: string | null }) => unknown) =>
		selector({ activeEnvironmentId: "env_1" }),
}));

const TAB: Tab = { id: "t1", type: "request", entityId: "req_1" };

const cookie = (name: string, domain: string): EngineCookie => ({
	name,
	value: "v",
	domain,
	path: "/",
	secure: false,
	httpOnly: false,
	expires: 0,
});

const variable = (value: string): ResolvedVariable =>
	({ value, scope: "environment", sourceId: "env_1", isSecret: false }) as ResolvedVariable;

/** A stored request with the fields every relevance hook reads. */
function restRequest(overrides: Record<string, unknown> = {}) {
	return {
		id: "req_1",
		collectionId: "col_1",
		url: "https://api.example.com/v1/users",
		bodyType: "json",
		body: { mode: "none" },
		params: [],
		headers: [],
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		...overrides,
	};
}

beforeEach(() => {
	request = restRequest();
	cookiesData = { scopes: [{ environmentId: "env_1", cookies: [] }] };
	cookiesLoading = false;
	runs = [];
	runsLoading = false;
	inScope = {};
});

describe("the GraphQL section's relevance", () => {
	it("hides itself off a GraphQL body", () => {
		// It used to render on every request tab to say "This request does not
		// send a GraphQL body" - and mounting it to say so pulled the ~320KB
		// `graphql` chunk (#1146) onto a tab that had no use for it.
		expect(renderHook(() => useGraphQLRelevance(TAB)).result.current).toBe("hidden");
	});

	it("appears for a request that does send one", () => {
		request = restRequest({
			bodyType: "graphql",
			body: { mode: "graphql", content: "{ me }" },
		});
		expect(renderHook(() => useGraphQLRelevance(TAB)).result.current).toBe("content");
	});

	it("stays hidden while the request has not arrived", () => {
		// The one hook that answers the quiet way before it knows: revealing and
		// then hiding would cost a chunk download to show a line saying the
		// section does not apply.
		request = undefined;
		expect(renderHook(() => useGraphQLRelevance(TAB)).result.current).toBe("hidden");
	});
});

describe("the cookies section's relevance", () => {
	it("hides itself while the URL has no host", () => {
		request = restRequest({ url: "/v1/users" });
		expect(renderHook(() => useCookiesRelevance(TAB)).result.current).toBe("hidden");
	});

	it("says none for a host whose jar is empty", () => {
		// Not hidden: "nothing is riding along" is an answer to a question people
		// open this section to ask.
		expect(renderHook(() => useCookiesRelevance(TAB)).result.current).toEqual({
			empty: "none",
		});
	});

	it("has content once one cookie matches the host", () => {
		cookiesData = {
			scopes: [{ environmentId: "env_1", cookies: [cookie("session", "api.example.com")] }],
		};
		expect(renderHook(() => useCookiesRelevance(TAB)).result.current).toBe("content");
	});

	it("reads the jar for the environment that is active, not the first one", () => {
		// The jar is per environment (#301). Counting another scope's cookies
		// would report content over a section that then renders empty.
		cookiesData = {
			scopes: [
				{ environmentId: "env_other", cookies: [cookie("session", "api.example.com")] },
				{ environmentId: "env_1", cookies: [] },
			],
		};
		expect(renderHook(() => useCookiesRelevance(TAB)).result.current).toEqual({
			empty: "none",
		});
	});

	it("waits rather than reporting empty while the jar is loading", () => {
		// A header that dims and then expands a moment later flickers; the
		// section's own loading line is the honest thing to show meanwhile.
		cookiesLoading = true;
		expect(renderHook(() => useCookiesRelevance(TAB)).result.current).toBe("content");
	});
});

describe("the recent-sends section's relevance", () => {
	it("says not sent yet for a request with no runs", () => {
		expect(renderHook(() => useRecentSendsRelevance(TAB)).result.current).toEqual({
			empty: "not sent yet",
		});
	});

	it("has content once the request has been sent", () => {
		runs = [{ id: "run_1" }];
		expect(renderHook(() => useRecentSendsRelevance(TAB)).result.current).toBe("content");
	});

	it("waits on the first load rather than reporting not-sent-yet", () => {
		runs = undefined;
		runsLoading = true;
		expect(renderHook(() => useRecentSendsRelevance(TAB)).result.current).toBe("content");
	});
});

describe("the variables section's relevance", () => {
	it("says none when the request references nothing and nothing is in scope", () => {
		expect(renderHook(() => useVariablesRelevance(TAB)).result.current).toEqual({
			empty: "none",
		});
	});

	it("has content when the request references a name, defined or not", () => {
		// An undefined reference is the most useful row the section has - "is
		// `{{vault_path}}` defined at all" - so it must not read as nothing.
		request = restRequest({ url: "https://api.example.com/{{vault_path}}" });
		expect(renderHook(() => useVariablesRelevance(TAB)).result.current).toBe("content");
	});

	it("has content when the request references none but the workspace defines some", () => {
		// The "All in scope" disclosure is the quick-edit path, and a dimmed
		// header would take it away.
		inScope = { shop_domain: variable("example.myshopify.com") };
		expect(renderHook(() => useVariablesRelevance(TAB)).result.current).toBe("content");
	});

	it("waits while the request has not arrived", () => {
		request = undefined;
		expect(renderHook(() => useVariablesRelevance(TAB)).result.current).toBe("content");
	});
});
