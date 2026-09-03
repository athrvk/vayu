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
 * The reader for `specTabTarget` (issue #680).
 *
 * The import dialog's Sync choice sets it and opens the collection; without
 * this effect the user lands on Info and has to find the Spec tab themselves -
 * which is the written-but-never-read defect CLAUDE.md names, and one no
 * store-level test can see.
 *
 * The clear is asserted too: a target left set would send the user to Spec every
 * time they opened that collection afterwards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import CollectionDetail from "./index";
import { useTabsStore } from "@/stores";

const collection = {
	id: "c1",
	name: "Petstore",
	description: "",
	variables: {},
	auth: { mode: "none" as const },
	preRequestScript: "",
	postRequestScript: "",
	order: 0,
	createdAt: "",
	updatedAt: "",
};

/**
 * The snippets list under a script editor reads the engine's completion table
 * (#1223). Its own behaviour is `ScriptSnippets.test.tsx`; here it only needs
 * to not reach for a QueryClient this suite does not set up.
 */
vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

vi.mock("@/queries/collections", () => ({
	useCollectionsQuery: () => ({ data: [collection], isLoading: false }),
	useRequestsQuery: () => ({ data: [], isLoading: false }),
	// The shell counts the whole subtree for its header (issue #723); an empty
	// map is "no requests anywhere", which is what these cases are about.
	useMultipleCollectionRequests: () => ({ requestsByCollection: new Map(), isLoading: false }),
}));

vi.mock("./AuthTab", () => ({ default: () => null }));
vi.mock("./InfoTab", () => ({ default: () => <div>info panel</div> }));
vi.mock("./ScriptTab", () => ({ default: () => null }));
vi.mock("./VariablesTab", () => ({ default: () => null }));
vi.mock("./DataTab", () => ({ default: () => null }));
vi.mock("./SpecTab", () => ({ default: () => <div>spec panel</div> }));
// Reaches the engine and the toast store; its own suite covers it.
vi.mock("./MockServerControl", () => ({ default: () => null }));

beforeEach(() => {
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "collection", entityId: "c1" }],
		activeTabId: "t1",
		specTabTarget: null,
	});
});

describe("a collection pointed at its Spec tab", () => {
	it("opens on Info when nothing pointed at it", () => {
		render(<CollectionDetail />);
		expect(screen.getByText("info panel")).toBeInTheDocument();
		expect(screen.queryByText("spec panel")).toBeNull();
	});

	it("opens on Spec, and consumes the target", () => {
		useTabsStore.setState({ specTabTarget: "c1" });
		render(<CollectionDetail />);
		expect(screen.getByText("spec panel")).toBeInTheDocument();
		expect(useTabsStore.getState().specTabTarget).toBeNull();
	});

	it("ignores a target naming a different collection", () => {
		useTabsStore.setState({ specTabTarget: "c2" });
		render(<CollectionDetail />);
		expect(screen.getByText("info panel")).toBeInTheDocument();
		// Still pending: the collection it names has not been on screen yet.
		expect(useTabsStore.getState().specTabTarget).toBe("c2");
	});
});
