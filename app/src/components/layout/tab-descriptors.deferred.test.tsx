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
 * An unnamed request's tab is titled by its resolved path, which a name a
 * pre-request script sets at send must not fill with the stored value (#2741).
 *
 * The names come from the `POST /compose` cache entry the Params panel and the
 * Code section share, read here and never fetched: this hook serves every open
 * tab and the palette, and a compose per tab is the cost #1310 removed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/queries/keys";

const composeRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: { composeRequest: (...args: unknown[]) => composeRequest(...args) },
}));

const REQUESTS: Record<string, unknown> = {
	req_unnamed: {
		id: "req_unnamed",
		name: "",
		method: "GET",
		url: "https://api.test/v1/{{token}}",
		params: [],
	},
	req_named: {
		id: "req_named",
		name: "Fetch user",
		method: "GET",
		url: "https://api.test/v1/{{token}}",
		params: [],
	},
	req_random: {
		id: "req_random",
		name: "",
		method: "GET",
		url: "https://api.test/{{token}}/{{$randomInt}}",
		params: [],
	},
};

const NO_COLLECTIONS: unknown[] = [];

vi.mock("@/queries", () => ({
	requestDetailOptions: (id: string | null) => ({
		queryKey: ["request", id],
		queryFn: async () => (id ? REQUESTS[id] : undefined),
		initialData: id ? REQUESTS[id] : undefined,
		enabled: false,
	}),
	runDetailOptions: (id: string | null) => ({
		queryKey: ["run", id],
		queryFn: async () => undefined,
		enabled: false,
	}),
	useCollectionsQuery: () => ({ data: NO_COLLECTIONS }),
	useInboxesQuery: () => ({ data: [] }),
	useMockServersQuery: () => ({ data: [] }),
}));

// One resolver for the file: the cache that keeps a generator from rerolling
// compares it by identity, as the real hook's memoised one is.
const resolveString = (text: string) =>
	text
		.replace("{{token}}", "stored-token")
		.replace("{{$randomInt}}", () => String(Math.floor(Math.random() * 1e9)));
vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ resolveString }),
}));

const { useSessionStore, useBoundRowStore } = await import("@/stores");
const { useTabDescriptors } = await import("./tab-descriptors");

const ENV = "env_1";
const composition = (deferredVariables: string[]) => ({
	payload: {},
	deferredVariables,
	editorSettings: null,
});

function mountTabs(ids: string[], client: QueryClient) {
	const tabs = ids.map((id) => ({ id: `t-${id}`, type: "request" as const, entityId: id }));
	return renderHook(() => useTabDescriptors(tabs), {
		wrapper: ({ children }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
}

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

beforeEach(() => {
	composeRequest.mockReset();
	useBoundRowStore.setState({ bound: null });
	useSessionStore.setState({ activeEnvironmentId: ENV });
});

describe("an unnamed request tab whose compose answer defers a name", () => {
	it("keeps the name written in the title instead of its stored value", () => {
		const client = newClient();
		client.setQueryData(
			queryKeys.compose.forRequest("req_unnamed", ENV, "saved"),
			composition(["token"])
		);
		const { result } = mountTabs(["req_unnamed"], client);

		expect(result.current[0].label).toBe("/v1/{{token}}");
		expect(result.current[0].title).toBe("GET /v1/{{token}}");
	});

	it("reads the entry the open builder composed, which a tab it has left still holds", () => {
		const client = newClient();
		client.setQueryData(
			queryKeys.compose.forRequest("req_unnamed", ENV, "editor"),
			composition(["token"])
		);
		const { result } = mountTabs(["req_unnamed"], client);

		expect(result.current[0].label).toBe("/v1/{{token}}");
	});

	it("follows the cache when the answer lands after the tab is drawn", async () => {
		const client = newClient();
		const { result } = mountTabs(["req_unnamed"], client);
		expect(result.current[0].label).toBe("/v1/stored-token");

		act(() => {
			client.setQueryData(
				queryKeys.compose.forRequest("req_unnamed", ENV, "saved"),
				composition(["token"])
			);
		});

		await waitFor(() => expect(result.current[0].label).toBe("/v1/{{token}}"));
	});

	it("resolves as it always did when the answer defers nothing the URL uses", () => {
		const client = newClient();
		client.setQueryData(
			queryKeys.compose.forRequest("req_unnamed", ENV, "saved"),
			composition(["unrelated"])
		);
		const { result } = mountTabs(["req_unnamed"], client);

		expect(result.current[0].label).toBe("/v1/stored-token");
	});

	it("does not read another environment's answer", () => {
		const client = newClient();
		client.setQueryData(
			queryKeys.compose.forRequest("req_unnamed", "env_other", "saved"),
			composition(["token"])
		);
		const { result } = mountTabs(["req_unnamed"], client);

		expect(result.current[0].label).toBe("/v1/stored-token");
	});

	it("leaves a request's own name alone", () => {
		const client = newClient();
		client.setQueryData(
			queryKeys.compose.forRequest("req_named", ENV, "saved"),
			composition(["token"])
		);
		const { result } = mountTabs(["req_named"], client);

		expect(result.current[0].label).toBe("Fetch user");
	});

	it("does not reroll a generator in the same URL on a re-render", () => {
		const client = newClient();
		client.setQueryData(
			queryKeys.compose.forRequest("req_random", ENV, "saved"),
			composition(["token"])
		);
		const { result, rerender } = mountTabs(["req_random"], client);
		const first = result.current[0].label;

		rerender();

		expect(first).toMatch(/^\/[^/]+\/\d+$/);
		expect(first.startsWith("/{{token}}/")).toBe(true);
		expect(result.current[0].label).toBe(first);
	});
});

describe("what reading the compose answer costs a tab", () => {
	it("never composes, for any number of tabs, whatever the cache holds", () => {
		const client = newClient();
		const { result } = mountTabs(["req_unnamed", "req_named", "req_random"], client);

		expect(result.current).toHaveLength(3);
		expect(composeRequest).not.toHaveBeenCalled();
	});
});
