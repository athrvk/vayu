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
 * One provider serves every request tab, so what a per-request map is keyed
 * by is a property of the provider, not of the rule that reads it (issue
 * #1269).
 *
 * That used to be three records: the body mode's `Content-Type` row, the
 * Event stream toggle's `Accept` row, and the GraphQL mode's method. All three
 * now mark ownership on the request's own state instead of in a provider-held
 * ref - the two header rows carry it on the row itself (`KeyValueEntry.source`,
 * see `utils/auto-header.ts`, issue #1481), and `method` carries it on
 * `RequestState.methodSource` (`graphql-method.ts`, issue #1505). A ref could
 * not survive a reload, so a stale auto-written value was then indistinguishable
 * from one the user chose; a value on the request itself is exactly as durable
 * as the rest of the request. There is nothing left here to say about any of
 * the three: none of them can leak between requests because none of them is
 * held anywhere but the request's own state, which `utils/auto-header.test.ts`,
 * `content-type.test.tsx` and `graphql-method.test.ts` already cover as pure
 * logic.
 *
 * What is left in this file is the Send-with-row picker's row memory (issue
 * #1271), which still is a provider-held per-request map - it has no row or
 * field on the request to carry its own marker, since a picked row is a fact
 * about the builder session, not about the request. The open-tab sweep that
 * bounds it is `retainKeys`, tested directly at the bottom.
 *
 * A builder that is not a saved request has no id to be keyed by and declares
 * one instead (issue #1272) - the History run copy, which passes its run id.
 * The first block asserts what the id-less key could not give two such copies
 * at once: a row pick each, bound by the declared identity rather than by a
 * request id neither copy has.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useEffect, Profiler } from "react";
import { render, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import { retainKeys } from "./retain-keys";
import { useTabsStore, type Tab } from "@/stores";
import type { RequestBuilderContextValue, RequestState } from "../types";

// The provider is wired to variable resolution, the save manager and several
// TanStack Query hooks. None of them matter to where a record is filed.
vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		getVariable: () => null,
		getAllVariables: () => ({}),
	}),
	useSaveManager: () => ({ forceSave: vi.fn(), status: "idle", isSaving: false }),
}));

vi.mock("@/queries", () => ({
	// RequestBuilderProvider now reads the catalogue itself (issue #1635); an
	// empty list means "nothing required", so the save-skip check is inert.
	useElementKindsQuery: () => ({ data: [] }),
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: () => [],
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
	useConfigQuery: () => ({ data: { entries: [] } }),
}));

/** What the tab strip is holding while a case runs. */
const TABS: Tab[] = [
	{ id: "tab_a", type: "request", entityId: "req_a" },
	{ id: "tab_b", type: "request", entityId: "req_b" },
];

/** The live context, re-captured on every render the provider does. */
let ctx: RequestBuilderContextValue;

function Probe() {
	const value = useRequestBuilderContext();
	useEffect(() => {
		ctx = value;
	});
	return null;
}

const tree = (id: string | null) => (
	<RequestBuilderProvider initialRequest={{ id, name: "r" } as Partial<RequestState>}>
		<Probe />
	</RequestBuilderProvider>
);

/**
 * A builder over something that is not a saved request: the copy History
 * renders for a stored run, which is id-less on purpose and says which run it
 * is with `memoryKey` (issue #1272).
 */
const runTree = (runId: string) => (
	<RequestBuilderProvider
		initialRequest={{ id: null, name: "r" } as Partial<RequestState>}
		memoryKey={runId}
	>
		<Probe />
	</RequestBuilderProvider>
);

beforeEach(() => {
	useTabsStore.setState({ openTabs: [...TABS], activeTabId: "tab_a" });
});

describe("row memory keyed by a declared identity", () => {
	/*
	 * Two run tabs, and the copy in each has `id: null` - the gate that stops an
	 * edited copy from rewriting the saved request. Before issue #1272 they were
	 * one identity: both filed under the id-less key, so the second copy's pick
	 * would have landed in the first one's slot.
	 */
	const RUN_TABS: Tab[] = [
		{ id: "tab_run_a", type: "run", entityId: "run_a" },
		{ id: "tab_run_b", type: "run", entityId: "run_b" },
	];

	beforeEach(() => {
		useTabsStore.setState({ openTabs: [...RUN_TABS], activeTabId: "tab_run_a" });
	});

	it("keeps the picked row of each run tab apart", async () => {
		// The row memory is filed under the same identity, so it divides with it.
		const { rerender } = render(runTree("run_a"));
		await act(async () => ctx.rememberRowIndex(2));

		await act(async () => rerender(runTree("run_b")));
		expect(ctx.lastRowIndex).toBeNull();

		await act(async () => rerender(runTree("run_a")));
		expect(ctx.lastRowIndex).toBe(2);
	});
});

describe("what bounds the picker's row memory", () => {
	it("forgets a request's picked row when its tab closes", async () => {
		const { rerender } = render(tree("req_a"));
		await act(async () => ctx.rememberRowIndex(2));
		expect(ctx.lastRowIndex).toBe(2);

		await act(async () => useTabsStore.getState().closeTab("tab_a"));

		await act(async () => rerender(tree("req_a")));
		expect(ctx.lastRowIndex).toBeNull();
	});

	it("keeps the picked row of a request whose tab is still open", async () => {
		const { rerender } = render(tree("req_a"));
		await act(async () => ctx.rememberRowIndex(2));

		// B's tab goes; A's pick is not B's and has no business going with it.
		await act(async () => useTabsStore.getState().closeTab("tab_b"));

		await act(async () => rerender(tree("req_a")));
		expect(ctx.lastRowIndex).toBe(2);
	});

	it("keeps the picked row of a builder that has no request id", async () => {
		const { rerender } = render(tree(null));
		await act(async () => ctx.rememberRowIndex(1));

		await act(async () => useTabsStore.getState().closeTab("tab_a"));

		await act(async () => rerender(tree(null)));
		expect(ctx.lastRowIndex).toBe(1);
	});

	it("stops re-rendering the provider once the tabs-store changes drop nothing", async () => {
		/*
		 * The sweep runs on *every* tabs-store write - the subscription takes the
		 * whole state - and the row memory is the one map it prunes with a
		 * `setState`. Without `retainKeys`' identity guard that would be a new
		 * object each time, so every tab focus would re-render the provider for
		 * the life of the session.
		 *
		 * Counted through a `Profiler` because the render is all there is to see:
		 * the context value is memoized on `lastRowIndex`, which such a write
		 * leaves untouched, so no child of the provider can tell the difference.
		 *
		 * The first focus after a pick still commits once - React renders a
		 * component that has just changed state one more time before it can bail
		 * out - so what is asserted is the steady state after that, which is what
		 * the guard is actually for.
		 */
		let commits = 0;
		render(
			<Profiler id="provider" onRender={() => (commits += 1)}>
				{tree("req_a")}
			</Profiler>
		);
		await act(async () => ctx.rememberRowIndex(2));
		await act(async () => useTabsStore.getState().focusTab("tab_b"));

		const settled = commits;
		await act(async () => useTabsStore.getState().focusTab("tab_a"));
		await act(async () => useTabsStore.getState().focusTab("tab_b"));
		expect(commits).toBe(settled);

		// And the counter is live: the write that *does* drop a key renders.
		await act(async () => useTabsStore.getState().closeTab("tab_a"));
		expect(commits).toBeGreaterThan(settled);
	});
});

describe("retainKeys", () => {
	/*
	 * The sweep runs on every tabs-store change, and the row memory is state, so
	 * the guard below is what keeps a tab focus from re-rendering the provider.
	 * Asserted here rather than through the provider because a `setState` that
	 * returns an equal-but-new object re-renders the provider and *nothing*
	 * else: the context value is memoized on `lastRowIndex`, which such a write
	 * leaves untouched, so no child can see the difference.
	 */
	it("returns the map it was given when every key is still live", () => {
		const previous = { req_a: 2, req_b: 0 };
		expect(retainKeys(previous, new Set(["req_a", "req_b", "req_c"]))).toBe(previous);
	});

	it("returns a new map with only the live keys when one is dropped", () => {
		const previous = { req_a: 2, req_b: 0 };
		const kept = retainKeys(previous, new Set(["req_b"]));
		expect(kept).not.toBe(previous);
		expect(kept).toEqual({ req_b: 0 });
	});

	it("returns the empty map it was given rather than a new one", () => {
		// The ordinary case: nothing has been picked, and every tab close would
		// otherwise write a fresh object.
		const previous = {};
		expect(retainKeys(previous, new Set(["req_a"]))).toBe(previous);
	});
});
