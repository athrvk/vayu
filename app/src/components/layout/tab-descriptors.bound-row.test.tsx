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
 * A tab's label and its builder agreeing about a bound data row (issue #1074).
 *
 * #1062 gave every preview *inside* the request builder the picked row, and
 * left this one behind: the strip labels every open tab from a single list-wide
 * resolver - it has to know each label before it can decide how many fit - so it
 * cannot take the row off the builder's context the way the URL bar does. A
 * request with no name of its own therefore labelled its tab from the
 * environment while the bar one row below showed the file's value.
 *
 * The slot the strip reads names its request, so the case that matters most is
 * the third: a row bound for *another* request must not relabel this one.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const request = {
	id: "req_a",
	// No name of its own, so the label falls back to the resolved path - which
	// is the only way a tab label reads a variable at all.
	name: "",
	method: "GET",
	url: "https://api.test/u/{{username}}",
};

vi.mock("@/queries", () => ({
	requestDetailOptions: (id: string | null) => ({
		queryKey: ["request", id],
		queryFn: async () => (id === request.id ? request : undefined),
		initialData: id === request.id ? request : undefined,
		enabled: false,
	}),
	runDetailOptions: (id: string | null) => ({
		queryKey: ["run", id],
		queryFn: async () => undefined,
		initialData: undefined,
		enabled: false,
	}),
	useCollectionsQuery: () => ({ data: [] }),
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useEnvironmentsQuery: () => ({
		data: [
			{
				id: "env",
				name: "Staging",
				// The collision the row tier exists for.
				variables: { username: { value: "from-the-environment", enabled: true } },
			},
		],
	}),
}));
vi.mock("@/stores", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/stores")>()),
	useSessionStore: () => ({ activeEnvironmentId: "env" }),
}));

const { useBoundRowStore } = await import("@/stores");
const { useTabDescriptors } = await import("./tab-descriptors");

const TABS = [{ id: "t1", type: "request" as const, entityId: "req_a" }];

function labelOfRequestTab() {
	const { result } = renderHook(() => useTabDescriptors(TABS), {
		wrapper: ({ children }) => (
			<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
		),
	});
	return result.current[0].label;
}

beforeEach(() => {
	useBoundRowStore.setState({ bound: null });
});

describe("a request tab's label while a row is bound", () => {
	it("resolves from the environment when the builder is bound to no row", () => {
		expect(labelOfRequestTab()).toBe("/u/from-the-environment");
	});

	it("resolves from the row once the builder is bound to one", () => {
		useBoundRowStore.setState({
			bound: { requestId: "req_a", row: { username: "ada" } },
		});
		expect(labelOfRequestTab()).toBe("/u/ada");
	});

	it("ignores a row bound for a different request", () => {
		// The slot is one deep, so the check that it names *this* request is what
		// keeps a pick made in another tab from relabelling this one.
		useBoundRowStore.setState({
			bound: { requestId: "req_b", row: { username: "ada" } },
		});
		expect(labelOfRequestTab()).toBe("/u/from-the-environment");
	});
});
