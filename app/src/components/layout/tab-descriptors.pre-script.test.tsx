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
 * An unnamed request tab is titled from the URL the way the Params panel's
 * "Sends" line reads it, and for a request the engine says runs a pre-request
 * script (`runsPreRequestScript`, #2741) that reading keeps a scope's
 * `{{name}}` written: the title must not show a path the stored scopes resolve
 * but a script can change. A `{{$dynamic}}` name still generates. Each case
 * runs once through the cache (no bound row) and once through the uncached
 * branch a bound data row takes.
 *
 * Mutation check: pass `request` to `sendsCacheInput` / `resolveSendsUrl`
 * without its flag (or make `resolveSends` ignore `scripted`) and the flagged
 * cases show the resolved path; drop `scripted` from the cache input and the
 * toggle case is served the previous title.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { KeyValueEntry } from "@/types";

const SEGMENT_URL = "https://api.test/users/{{seg}}";

let request: {
	id: string;
	name: string;
	method: string;
	url: string;
	params: KeyValueEntry[];
	disableUrlEncoding: boolean;
	runsPreRequestScript?: boolean;
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

function titleOfRequestTab(id: string) {
	const tabs = [{ id: "t1", type: "request" as const, entityId: id }];
	const { result } = renderHook(() => useTabDescriptors(tabs), {
		wrapper: ({ children }) => (
			<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
		),
	});
	return result.current[0].label;
}

/** The cache is keyed by request id, so a case that must not share one gets its own. */
let nextId = 0;
function openRequest(patch: Partial<typeof request>) {
	request = {
		id: `req_script_${nextId++}`,
		name: "",
		method: "GET",
		url: SEGMENT_URL,
		params: [],
		disableUrlEncoding: false,
		...patch,
	};
}

// The second case binds a row whose cells answer the same name the environment
// does, so the unflagged title is the same text on both branches.
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

describe.each(BRANCHES)("%s", (_branch, bind) => {
	it("resolves a scope's name in the path when no script runs", () => {
		openRequest({ runsPreRequestScript: false });
		bind();
		expect(titleOfRequestTab(request.id)).toBe("/users/a");
	});

	it("keeps the name written when the request runs a pre-request script", () => {
		openRequest({ runsPreRequestScript: true });
		bind();
		expect(titleOfRequestTab(request.id)).toBe("/users/{{seg}}");
	});

	it("still generates a {{$dynamic}} name in the path of a scripted request", () => {
		openRequest({ runsPreRequestScript: true, url: "https://api.test/{{seg}}/{{$randomInt}}" });
		bind();
		const title = titleOfRequestTab(request.id);
		expect(title.startsWith("/{{seg}}/")).toBe(true);
		expect(title.slice("/{{seg}}/".length)).toMatch(/^\d+$/);
	});

	it("leaves a request with its own name titled by that name", () => {
		openRequest({ runsPreRequestScript: true, name: "Get user" });
		bind();
		expect(titleOfRequestTab(request.id)).toBe("Get user");
	});
});

describe("the cached title and the flag", () => {
	it("follows a flag that changes for the same request id", () => {
		openRequest({ runsPreRequestScript: false });
		expect(titleOfRequestTab(request.id)).toBe("/users/a");
		request = { ...request, runsPreRequestScript: true };
		expect(titleOfRequestTab(request.id)).toBe("/users/{{seg}}");
		request = { ...request, runsPreRequestScript: false };
		expect(titleOfRequestTab(request.id)).toBe("/users/a");
	});
});
