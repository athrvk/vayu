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
 * An unnamed request's tab is titled by its path, resolved in its own
 * collection's scope (#3686). The strip's resolver has no collection of its own,
 * so a URL that starts with a collection variable used to keep its raw token
 * and, because it then did not parse, its query string.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const request = {
	id: "req_a",
	name: "",
	method: "GET",
	url: "{{baseUrl}}/v1/x?key={{apiKey}}",
	params: [],
	collectionId: "col_a",
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
	useCollectionsQuery: () => ({
		data: [
			{
				id: "col_a",
				name: "Shop",
				parentId: null,
				variables: { baseUrl: { value: "https://shop.test", enabled: true } },
			},
		],
	}),
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useEnvironmentsQuery: () => ({
		data: [
			{
				id: "env",
				name: "Staging",
				variables: { apiKey: { value: "s3cr3t", enabled: true, secret: true } },
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

const { useTabDescriptors } = await import("./tab-descriptors");

const TABS = [{ id: "t1", type: "request" as const, entityId: "req_a" }];

function descriptor() {
	const { result } = renderHook(() => useTabDescriptors(TABS), {
		wrapper: ({ children }) => (
			<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
		),
	});
	return result.current[0];
}

describe("an unnamed request's tab under a collection-scoped base URL", () => {
	it("is titled by its path, resolved in the request's own collection", () => {
		expect(descriptor().label).toBe("/v1/x");
	});

	it("carries no query string in the title, the tooltip or the copied path", () => {
		const d = descriptor();
		for (const text of [d.label, d.title, d.path]) {
			expect(text).not.toContain("?");
			expect(text).not.toContain("s3cr3t");
		}
	});
});
