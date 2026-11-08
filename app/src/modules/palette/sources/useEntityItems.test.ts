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
 * Issue #1716: this was the one palette source that built its `items` array on
 * every render instead of memoising it - `useRunItems`, `useSettingsItems` and
 * `useVariableItems` all do. The palette itself re-renders on every keystroke
 * (it is filtering as the user types), so an unmemoized build here redid every
 * collection, every request in it and a `collectionPath` walk per collection on
 * every character typed, whether or not any of it had changed.
 *
 * Mutation check: drop the `useMemo` around the build (return the loop's result
 * directly) and the identity assertion below fails - two renders with the same
 * inputs would then return two different arrays.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useEntityItems } from "./useEntityItems";
import type { Collection, Request, Run } from "@/types";

const openTab = vi.fn();

vi.mock("@/stores", () => ({
	useTabsStore: (selector: (state: { openTab: typeof openTab }) => unknown) =>
		selector({ openTab }),
}));

function collection(id: string, name: string, parentId?: string): Collection {
	return {
		id,
		name,
		...(parentId ? { parentId } : {}),
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements: [],
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	};
}

// A root, a child and a grandchild, so the subtitle (where it sits) is
// exercised at every depth.
const collections: Collection[] = [
	collection("c1", "Payments"),
	collection("c2", "Auth", "c1"),
	collection("c3", "Tokens", "c2"),
];

// Only the fields the hook reads - `id`, `name`, `method`, `url` - matter to
// this test; the rest of `Request`'s shape is irrelevant to it.
function request(
	id: string,
	collectionId: string,
	name: string,
	url = "https://api.example/user"
): Request {
	return {
		id,
		collectionId,
		name,
		method: "GET",
		url,
		order: 0,
		headers: [],
		params: [],
		auth: { mode: "none" },
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	} as unknown as Request;
}

const requestsByCollection = new Map<string, Request[]>([
	["c1", [request("r1", "c1", "Get user")]],
	["c3", [request("r2", "c3", "Refresh token")]],
	[
		"c2",
		[
			request("r3", "c2", "New Request", "https://api.example/v1/orders"),
			request("r4", "c2", "", "https://api.example/v1/invoices"),
		],
	],
]);

const runsData = { pages: [{ runs: [] as Run[] }] };

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ data: collections }),
	useMultipleCollectionRequests: () => ({ requestsByCollection }),
	useRunsQuery: () => ({ data: runsData }),
	flattenRunPages: () => [],
}));

describe("useEntityItems", () => {
	it("returns the same array reference across renders with the same inputs", () => {
		const { result, rerender } = renderHook(() => useEntityItems());
		const first = result.current;

		rerender();
		const second = result.current;

		expect(second).toBe(first);
	});

	it("still builds the collection and request rows", () => {
		const { result } = renderHook(() => useEntityItems());
		expect(result.current.map((item) => item.id)).toEqual([
			"collection:c1",
			"request:r1",
			"collection:c2",
			"request:r3",
			"request:r4",
			"collection:c3",
			"request:r2",
		]);
	});

	it("subtitles a row with where it sits: the parent path for a collection, its own path for a request", () => {
		const { result } = renderHook(() => useEntityItems());
		const subtitles = Object.fromEntries(
			result.current.map((item) => [item.id, item.subtitle])
		);
		expect(subtitles).toEqual({
			"collection:c1": undefined,
			"collection:c2": "Payments",
			"collection:c3": "Payments / Auth",
			"request:r1": "Payments",
			"request:r2": "Payments / Auth / Tokens",
			"request:r3": "Payments / Auth",
			"request:r4": "Payments / Auth",
		});
	});

	it("names the request a row opens, matching what its open tab carries", () => {
		const { result } = renderHook(() => useEntityItems());
		const keys = Object.fromEntries(result.current.map((item) => [item.id, item.entityKey]));
		expect(keys["request:r1"]).toBe("request:r1");
		expect(keys["collection:c1"]).toBeUndefined();
	});

	it("titles a request as its tab does: its own name, else its URL path", () => {
		const { result } = renderHook(() => useEntityItems());
		const titles = Object.fromEntries(result.current.map((item) => [item.id, item.title]));
		expect(titles["request:r1"]).toBe("Get user");
		// The default placeholder and a blank name both count as unnamed.
		expect(titles["request:r3"]).toBe("/v1/orders");
		expect(titles["request:r4"]).toBe("/v1/invoices");
	});
});
