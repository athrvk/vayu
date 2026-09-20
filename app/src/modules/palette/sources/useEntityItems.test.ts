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

const collections: Collection[] = [
	{
		id: "c1",
		name: "Payments",
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements: [],
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	},
];

// Only the fields the hook reads - `id`, `name`, `method`, `url` - matter to
// this test; the rest of `Request`'s shape is irrelevant to it.
const requestsByCollection = new Map<string, Request[]>([
	[
		"c1",
		[
			{
				id: "r1",
				collectionId: "c1",
				name: "Get user",
				method: "GET",
				url: "https://api.example/user",
				order: 0,
				headers: [],
				params: [],
				auth: { mode: "none" },
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
			} as unknown as Request,
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
		expect(result.current.map((item) => item.id)).toEqual(["collection:c1", "request:r1"]);
	});
});
