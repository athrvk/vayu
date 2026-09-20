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
 * Where a collection sits, above its tab strip (#1691).
 *
 * The screen used to open with a title and nothing else, so a collection
 * imported as one tag folder of forty gave no clue which spec it belonged to -
 * the same blind spot the request builder had before its crumb.
 *
 * Two claims, and the second is the one a source scan would miss: a **root**
 * collection draws no band, because its chain is one segment and that segment is
 * the header title repeated underneath itself.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CollectionDetail from "./index";

const openTab = vi.fn();
let activeCollectionId = "tag-users";

const collections = [
	{ id: "spec-root", name: "GitHub v3 REST API", variables: {} },
	{ id: "tag-users", name: "users", parentId: "spec-root", variables: {} },
];

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => ({ data: collections, isLoading: false, isError: false }),
	useRequestsQuery: () => ({ data: [], isLoading: false }),
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map(), isLoading: false }),
}));

vi.mock("@/stores", () => ({
	useTabsStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({
			openTabs: [{ id: "t1", type: "collection", entityId: activeCollectionId }],
			activeTabId: "t1",
			openTab,
		}),
	useSessionStore: (selector: (s: unknown) => unknown) =>
		selector({ setLastCollectionId: vi.fn() }),
}));

vi.mock("./InfoTab", () => ({ default: () => null }));
vi.mock("./AuthTab", () => ({ default: () => null }));
vi.mock("./VariablesTab", () => ({ default: () => null }));
// Reaches the engine and the toast store; its own suite covers it.
vi.mock("./MockServerControl", () => ({ default: () => null }));

const crumb = () => screen.queryByRole("navigation", { name: "Collection location" });

describe("the collection screen's crumb line", () => {
	it("names the chain a nested collection sits in, and opens a parent's tab", () => {
		activeCollectionId = "tag-users";
		render(<CollectionDetail />);

		expect(crumb()?.textContent).toBe("GitHub v3 REST APIusers");

		screen.getByRole("button", { name: "GitHub v3 REST API" }).click();
		expect(openTab).toHaveBeenCalledWith({ type: "collection", entityId: "spec-root" });
	});

	it("draws no band for a root collection - it would repeat the header", () => {
		activeCollectionId = "spec-root";
		render(<CollectionDetail />);

		expect(crumb()).toBeNull();
	});
});
