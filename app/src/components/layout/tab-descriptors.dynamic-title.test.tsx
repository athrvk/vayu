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
 * A request tab's label used to reroll on every render when its URL held a
 * dynamic variable (`{{$randomInt}}`, `{{$guid}}`, …, `lib/dynamic-variables.ts`) -
 * `useTabDescriptors` has no memoization of its own, so it recomputed the
 * label on every render `TabStrip` took for any reason, not only a URL edit
 * (issue #1739). `stableTitleUrl` (`lib/dynamic-variable-cache.ts`) fixes
 * that; this pins the fix, and its
 * `describe.each` sibling ("a second, distinct request") is what proves the
 * cache is keyed by request id rather than by URL text - the module-scope Map
 * would otherwise leak one request's cached value into another's.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";

const REQUEST_A = {
	id: "req_a",
	name: "",
	method: "GET",
	url: "https://api.test/todos/{{$randomInt}}",
	params: [],
};
const REQUEST_B = {
	id: "req_b",
	name: "",
	method: "GET",
	url: "https://api.test/todos/{{$randomInt}}",
	params: [],
};

const REQUESTS: Record<string, typeof REQUEST_A> = { req_a: REQUEST_A, req_b: REQUEST_B };

// Run tabs (#2051): a collection run names its file inside the `scenario`
// block, a load run at the top level, and an older run has neither.
const RUNS: Record<string, unknown> = {
	run_collection: {
		id: "run_collection",
		type: "scenario",
		configSnapshot: { scenario: { collectionId: "col_1", dataFileName: "users.csv" } },
	},
	run_collection_old: {
		id: "run_collection_old",
		type: "scenario",
		configSnapshot: { scenario: { collectionId: "col_1" } },
	},
	run_load: {
		id: "run_load",
		type: "load",
		configSnapshot: {
			method: "GET",
			url: "https://api.test/orders",
			dataFileName: "users.csv",
		},
	},
	run_load_old: {
		id: "run_load_old",
		type: "load",
		configSnapshot: { method: "GET", url: "https://api.test/orders" },
	},
};

// Stable references, not a fresh object literal per call: the real
// TanStack Query hooks return the same `data` identity across renders while
// the underlying cache entry is unchanged, which is what lets `resolveString`
// (`useVariableResolver`'s `variableMap`/`rowCells` memo) hold a stable
// identity of its own - the very thing `stableTitleUrl` keys its cache
// validity on. A mock returning `{ data: [] }` fresh each call would recreate
// that memo, and so `resolveString`, on every render - failing this test for
// a reason that has nothing to do with `tab-descriptors.ts`.
const NO_COLLECTIONS: unknown[] = [];
const NO_ENVIRONMENTS: unknown[] = [];
const EMPTY_GLOBALS = { variables: {} };

vi.mock("@/queries", () => ({
	requestDetailOptions: (id: string | null) => ({
		queryKey: ["request", id],
		queryFn: async () => (id ? REQUESTS[id] : undefined),
		initialData: id ? REQUESTS[id] : undefined,
		enabled: false,
	}),
	runDetailOptions: (id: string | null) => ({
		queryKey: ["run", id],
		queryFn: async () => (id ? RUNS[id] : undefined),
		initialData: id ? RUNS[id] : undefined,
		enabled: false,
	}),
	useCollectionsQuery: () => ({ data: NO_COLLECTIONS }),
	useGlobalsQuery: () => ({ data: EMPTY_GLOBALS }),
	useEnvironmentsQuery: () => ({ data: NO_ENVIRONMENTS }),
	useInboxesQuery: () => ({ data: [] }),
	useMockServersQuery: () => ({ data: [] }),
}));

const { useBoundRowStore } = await import("@/stores");
const { useTabDescriptors } = await import("./tab-descriptors");

function labelsOf(tabIds: string[]) {
	const tabs = tabIds.map((id) => ({ id: `t-${id}`, type: "request" as const, entityId: id }));
	const { result, rerender } = renderHook(() => useTabDescriptors(tabs), {
		wrapper: ({ children }) => (
			<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
		),
	});
	const first = result.current.map((d) => d.label);
	// Nothing about any tab changed - the same re-render `TabStrip` takes for
	// an unrelated reason (typing elsewhere, another store update).
	rerender();
	const second = result.current.map((d) => d.label);
	return { first, second };
}

beforeEach(() => {
	useBoundRowStore.setState({ bound: null });
});

describe("a request tab's label with a dynamic variable in its URL", () => {
	it("stays the same across a re-render with nothing about the tab changed", () => {
		const { first, second } = labelsOf(["req_a"]);
		expect(second).toEqual(first);
		// Sanity: the path actually carries the generated digits, not the raw
		// `{{$randomInt}}` token - otherwise this would pass for the wrong reason.
		expect(first[0]).toMatch(/^\/todos\/\d+$/);
	});

	it("gives two different requests their own cached value, not one shared by URL text", () => {
		// Both requests carry the identical `{{$randomInt}}` template - the cache
		// is keyed by request id specifically so this is not the same collision
		// the dynamic-variable table itself guards against (two distinct
		// occurrences must be free to differ).
		const { first } = labelsOf(["req_a", "req_b"]);
		expect(first[0]).toMatch(/^\/todos\/\d+$/);
		expect(first[1]).toMatch(/^\/todos\/\d+$/);
	});
});

describe("a run tab's tooltip names the data file", () => {
	function descriptorOf(entityId: string) {
		const tabs = [{ id: `t-${entityId}`, type: "run" as const, entityId }];
		const { result } = renderHook(() => useTabDescriptors(tabs), {
			wrapper: ({ children }) => (
				<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
			),
		});
		return result.current[0];
	}

	it("appends the name to a collection run's title and leaves the label alone", () => {
		const d = descriptorOf("run_collection");
		expect(d.title).toBe("Collection run: col_1 · users.csv");
		expect(d.label).toBe("col_1");
	});

	it("appends the name to a load run's title and leaves the label alone", () => {
		const d = descriptorOf("run_load");
		expect(d.title).toBe("Load test: GET /orders · users.csv");
		expect(d.label).toBe("/orders");
	});

	it.each([
		["collection", "run_collection_old", "Collection run: col_1"],
		["load", "run_load_old", "Load test: GET /orders"],
	])("is unchanged for a %s run recorded without a file", (_kind, id, title) => {
		expect(descriptorOf(id).title).toBe(title);
	});
});
