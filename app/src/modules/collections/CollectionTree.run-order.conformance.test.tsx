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
 * Cross-consumer conformance: the request sequence the sidebar *displays* for a
 * recursive run against the sequence the engine's plan *executes* (issue #431).
 *
 * `CollectionTree.folders-first.test.tsx` pins the relationship between one
 * folder's two blocks, and `tree-order-conformance.json` pins the order within a
 * block. Neither could notice the case this file exists for: the engine's walk
 * was pre-order (a folder's own requests, then its subfolders'), the tree renders
 * subfolders above requests at every depth, and each side had a test asserting
 * its own order. "Run this folder" therefore executed in a sequence the user had
 * never seen - the #360 defect one level up.
 *
 * So the fixture is read by both sides:
 * `engine/tests/scenario_plan_test.cpp` seeds each case and reads
 * `resolve_scenario`'s step ids; this file renders the same tree fully expanded
 * and reads the request rows top to bottom out of the DOM. The render is the
 * assertion subject, not a re-derivation of it - a comparator copy here would be
 * the second source of truth the fixture exists to prevent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { TooltipProvider } from "@/components/ui";
import { useTabsStore } from "@/stores";
import { compareTreeOrder } from "@/types";
import { useCollectionsStore } from "./collections-store";
import CollectionTree from "./CollectionTree";

/** Held in the testkit, so CI routes an edit to the fixture back to this suite. */
const [fixturePath] = ENGINE_READING_GUARDS.recursiveRunOrder.paths.map(fromRepoRoot);

interface FixtureCollection {
	id: string;
	parentId: string | null;
	order: number;
	createdAt: number;
}
interface FixtureRequest {
	id: string;
	collectionId: string;
	order: number;
	createdAt: number;
}
interface ConformanceCase {
	name: string;
	rootId: string;
	collections: FixtureCollection[];
	requests: FixtureRequest[];
	expected: string[];
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
	description: string;
	cases: ConformanceCase[];
};

/**
 * The rows the mocked query layer serves. The renderer holds `createdAt` as the
 * ISO string its transformers produce from the engine's epoch-millisecond
 * column, so the fixture is fed in through that conversion rather than in a
 * shape the app never has.
 */
interface TreeData {
	collections: Array<{
		id: string;
		name: string;
		parentId?: string;
		order: number;
		createdAt: string;
	}>;
	requestsByCollection: Map<
		string,
		Array<{
			id: string;
			collectionId: string;
			name: string;
			method: string;
			order: number;
			createdAt: string;
		}>
	>;
}

let current: TreeData = { collections: [], requestsByCollection: new Map() };

vi.mock("@/queries", () => ({
	useReorderMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useCollectionsQuery: () => ({
		data: current.collections,
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useMultipleCollectionRequests: () => ({ requestsByCollection: current.requestsByCollection }),
	useCreateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteCollectionMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useCreateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useRestoreTrashMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

/**
 * `reverseInput` feeds the collections list back to front. The tree sorts roots
 * and each folder's children itself, so a case that only passes in fixture order
 * would be reading the array rather than applying the rule. The request lists
 * are *not* reversed: the tree renders them as the query layer hands them over,
 * and that layer's sort is pinned by `tree-order.conformance.test.ts`.
 */
function toTreeData(c: ConformanceCase, reverseInput = false): TreeData {
	const collections = c.collections.map((col) => ({
		id: col.id,
		name: `Collection ${col.id}`,
		...(col.parentId ? { parentId: col.parentId } : {}),
		order: col.order,
		createdAt: new Date(col.createdAt).toISOString(),
	}));

	const requestsByCollection: TreeData["requestsByCollection"] = new Map();
	for (const req of c.requests) {
		const row = {
			id: req.id,
			collectionId: req.collectionId,
			name: `Request ${req.id}`,
			method: "GET",
			order: req.order,
			createdAt: new Date(req.createdAt).toISOString(),
		};
		requestsByCollection.set(req.collectionId, [
			...(requestsByCollection.get(req.collectionId) ?? []),
			row,
		]);
	}
	// The query layer hands each collection's list out already sorted
	// (`queries/collections.ts`, pinned by tree-order.conformance.test.ts); only
	// the folders/requests split and the child order are this file's subject.
	for (const [id, rows] of requestsByCollection) {
		requestsByCollection.set(id, [...rows].sort(compareTreeOrder));
	}

	return {
		collections: reverseInput ? [...collections].reverse() : collections,
		requestsByCollection,
	};
}

/** The request rows the tree displays, top to bottom. */
function displayedRequestIds(c: ConformanceCase, reverseInput = false): string[] {
	current = toTreeData(c, reverseInput);
	useCollectionsStore.setState({
		expandedCollectionIds: new Set(c.collections.map((col) => col.id)),
	});
	const { container } = render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<CollectionTree />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return Array.from(container.querySelectorAll("[data-request-id]")).map(
		(row) => row.getAttribute("data-request-id") ?? ""
	);
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn();
	useTabsStore.setState({ openTabs: [], activeTabId: null });
});

describe("recursive-run-order conformance fixture", () => {
	it("scanned a non-empty fixture (guards the scan itself)", () => {
		expect(fixture.cases.length).toBeGreaterThanOrEqual(5);
		for (const c of fixture.cases) {
			expect(c.collections.length).toBeGreaterThan(1);
			expect(c.expected.length).toBe(c.requests.length);
			// Every case is a folder that holds subfolders, which is the only shape
			// the two blocks can disagree about.
			expect(c.collections.some((col) => col.parentId === c.rootId)).toBe(true);
		}
	});

	it.each(fixture.cases.map((c) => [c.name, c] as const))(
		"displays the run order: %s",
		(_name, c) => {
			expect(displayedRequestIds(c)).toEqual(c.expected);
		}
	);

	it("displays the same order whatever order the rows arrive in", () => {
		for (const c of fixture.cases) {
			expect(displayedRequestIds(c, /*reverseInput=*/ true)).toEqual(c.expected);
		}
	});
});
