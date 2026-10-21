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
 * A request tab titled from its URL reads the URL the way the Params panel's
 * "Sends" line does (#2637): a path row's value lands in its `:name` segment,
 * encoded as the engine writes it (`?` is `%3F`, one segment, not a path cut
 * short at a query) unless `disableUrlEncoding` sends it as typed. The title
 * used to resolve the bare URL text, so it kept `/users/:name`.
 *
 * The value carries `?` because `pathLabel` decodes what it draws: a space
 * reads `a b` whether the URL held `a b` or `a%20b`, so it cannot tell the two
 * resolutions apart. Each case runs once through the cache (no bound row) and
 * once through the uncached branch a bound data row takes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { KeyValueEntry } from "@/types";

const SEGMENT_URL = "https://api.test/users/{{seg}}";
const PATH_ROW_URL = "https://api.test/users/:name";
const pathRow = (value: string): KeyValueEntry => ({
	key: "name",
	value,
	enabled: true,
	in: "path",
});

let request: {
	id: string;
	name: string;
	method: string;
	url: string;
	params: KeyValueEntry[];
	disableUrlEncoding: boolean;
};

vi.mock("@/queries", () => ({
	requestDetailOptions: (id: string | null) => ({
		queryKey: ["request", id, request],
		queryFn: async () => request,
		initialData: id ? request : undefined,
		enabled: false,
	}),
	runDetailOptions: () => ({
		queryKey: ["run"],
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
				variables: { seg: { value: "a?b", enabled: true } },
			},
		],
	}),
	useInboxesQuery: () => ({ data: [] }),
	useMockServersQuery: () => ({ data: [] }),
}));
vi.mock("@/stores", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/stores")>()),
	useSessionStore: (selector: (s: { activeEnvironmentId: string }) => unknown) =>
		selector({ activeEnvironmentId: "env" }),
}));

const { useBoundRowStore } = await import("@/stores");
const { useTabDescriptors } = await import("./tab-descriptors");
const { resolveSendsUrl } = await import("@/modules/request-builder/utils/sends-url");
const { pathLabel } = await import("@/lib/path-label");

function titleOfRequestTab(id: string) {
	const tabs = [{ id: "t1", type: "request" as const, entityId: id }];
	const { result } = renderHook(() => useTabDescriptors(tabs), {
		wrapper: ({ children }) => (
			<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
		),
	});
	return result.current[0].label;
}

/** The cache is keyed by request id, so every case gets an id of its own. */
let nextId = 0;
function openRequest(patch: Partial<typeof request>) {
	request = {
		id: `req_encoding_${nextId++}`,
		name: "",
		method: "GET",
		url: SEGMENT_URL,
		params: [],
		disableUrlEncoding: false,
		...patch,
	};
}

// The second case binds a row whose cells answer the same names the environment
// does, so both branches resolve to the same text and must encode it alike.
const BRANCHES = [
	["the cached title", () => useBoundRowStore.setState({ bound: null })],
	[
		"the bound-row title",
		() =>
			useBoundRowStore.setState({
				bound: { requestId: request.id, row: { seg: "a?b" } },
			}),
	],
] as const;

beforeEach(() => {
	useBoundRowStore.setState({ bound: null });
});

const resolveSeg = (text: string) => text.split("{{seg}}").join("a?b");

describe.each(BRANCHES)("%s", (_branch, bind) => {
	it("agrees with the Sends line for a variable in the URL's own path", () => {
		openRequest({ url: SEGMENT_URL });
		bind();
		expect(titleOfRequestTab(request.id)).toBe(pathLabel(resolveSendsUrl(request, resolveSeg)));
	});

	it("writes a path row's resolved value into its `:name` segment, encoded", () => {
		openRequest({ url: PATH_ROW_URL, params: [pathRow("{{seg}}")] });
		bind();
		const sends = resolveSendsUrl(request, resolveSeg);
		expect(sends).toBe("https://api.test/users/a%3Fb");
		expect(titleOfRequestTab(request.id)).toBe(pathLabel(sends));
		expect(titleOfRequestTab(request.id)).toBe("/users/a?b");
	});

	it("leaves a path row's value as typed under disableUrlEncoding", () => {
		openRequest({
			url: PATH_ROW_URL,
			params: [pathRow("{{seg}}")],
			disableUrlEncoding: true,
		});
		bind();
		const sends = resolveSendsUrl(request, resolveSeg);
		expect(sends).toBe("https://api.test/users/a?b");
		expect(titleOfRequestTab(request.id)).toBe(pathLabel(sends));
		expect(titleOfRequestTab(request.id)).toBe("/users/a");
	});
});
