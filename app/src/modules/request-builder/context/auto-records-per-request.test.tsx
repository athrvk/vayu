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
 * One provider serves every request tab, so what a reversible-setting record
 * is keyed by is a property of the provider, not of the rule that reads it
 * (issue #1269).
 *
 * That used to be three records: the body mode's `Content-Type` row, the
 * Event stream toggle's `Accept` row, and the GraphQL mode's method. The first
 * two now mark ownership on the row itself (`KeyValueEntry.source`, see
 * `utils/auto-header.ts`) instead of in a provider-held ref - the ref could
 * not survive a reload, so a stale auto-written row was then indistinguishable
 * from one the user typed (issue #1481). There is nothing left for *this* file
 * to say about them: a marked row cannot leak between requests because it is
 * never held anywhere but the request's own headers, which
 * `utils/auto-header.test.ts` and `content-type.test.tsx` already cover as
 * pure logic.
 *
 * What is left here is the method record, which still needs one: `method` is a
 * scalar field, not a `KeyValueEntry`, so it has nowhere to carry a marker of
 * its own and stays on the provider's per-request map. Before issue #1269, a
 * second request entering GraphQL overwrote the first request's record,
 * leaving the first with a method the app had changed for it and nothing left
 * that knew it was the app's - the failure mode this file guards.
 *
 * The panel is stood in for rather than driven, as in
 * `body-drafts-lifetime.test.tsx`: `BodyPanel` only writes when a Radix
 * `Select` commits, and a Select does not commit in jsdom. `applyModeChange`
 * below makes exactly the calls the panel makes, in the same order, through
 * the real rules. The Event stream toggle's `Accept` row needs no such stand-in
 * any more - it has no provider-held record left to exercise - so its own
 * rule is tested directly in `utils/auto-header.test.ts`.
 *
 * A builder that is not a saved request has no id to be keyed by and declares
 * one instead (issue #1272) - the History run copy, which passes its run id.
 * The block for it asserts what the id-less key could not give two such copies
 * at once: a record each, and a bound, since a declared identity names a tab.
 *
 * The last two blocks are the Send-with-row picker's row memory (issue #1271),
 * here rather than in a file of its own because what they check is the same
 * open-tab sweep: it bounds every per-request map the provider holds, and a
 * rule with two callers is worth asserting from both.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useEffect, Profiler } from "react";
import { render, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import { switchContentType } from "../components/RequestTabs/panels/body/content-type";
import { switchGraphQLMethod } from "../components/RequestTabs/panels/body/graphql-method";
import { retainKeys } from "./retain-keys";
import { useTabsStore, type Tab } from "@/stores";
import type { BodyMode, HttpMethod, KeyValueItem } from "@/types";
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

/** Just enough of a request for the two rules under test. */
interface Draft {
	id: string | null;
	headers: KeyValueItem[];
	method: HttpMethod;
}

const fresh = (id: string | null): Draft => ({ id, headers: [], method: "GET" });

/** The two writes `BodyPanel.handleModeChange` makes, in its order. */
function applyModeChange(draft: Draft, mode: BodyMode): Draft {
	const contentType = switchContentType(mode, draft.headers);

	const graphqlMethod = switchGraphQLMethod(mode, draft.method, draft.id, ctx.getAutoMethod());
	ctx.setAutoMethod(graphqlMethod.auto);

	return { ...draft, headers: contentType.headers, method: graphqlMethod.method };
}

const headerNames = (draft: Draft) => draft.headers.map((row) => row.key);

beforeEach(() => {
	useTabsStore.setState({ openTabs: [...TABS], activeTabId: "tab_a" });
});

describe("a record per request, not per setting", () => {
	it("lets the first request leave GraphQL after a second one has entered it", async () => {
		const { rerender } = render(tree("req_a"));

		let a = applyModeChange(fresh("req_a"), "graphql");
		expect(headerNames(a)).toEqual(["Content-Type"]);
		expect(a.method).toBe("POST");

		// The user switches to request B and picks GraphQL there too. One provider
		// serves both tabs, so B's method record lands in the same slot - the
		// Content-Type row has no such slot to collide in any more (issue #1481).
		await act(async () => rerender(tree("req_b")));
		const b = applyModeChange(fresh("req_b"), "graphql");
		expect(headerNames(b)).toEqual(["Content-Type"]);
		expect(b.method).toBe("POST");

		// Back to A, and out of GraphQL. Both of the app's changes come back out.
		await act(async () => rerender(tree("req_a")));
		a = applyModeChange(a, "none");
		expect(headerNames(a)).toEqual([]);
		expect(a.method).toBe("GET");
	});

	it("answers with nothing for a request that has entered no mode", async () => {
		// Guards the case above: it would also pass if every request read one
		// shared method record back.
		const { rerender } = render(tree("req_a"));
		applyModeChange(fresh("req_a"), "graphql");

		await act(async () => rerender(tree("req_b")));
		expect(ctx.getAutoMethod()).toBeNull();
	});
});

describe("what bounds the method record", () => {
	it("forgets a request's method record when its tab closes", async () => {
		const { rerender } = render(tree("req_a"));
		applyModeChange(fresh("req_a"), "graphql");

		await act(async () => useTabsStore.getState().closeTab("tab_a"));

		await act(async () => rerender(tree("req_a")));
		expect(ctx.getAutoMethod()).toBeNull();
	});

	it("keeps the method record of the tabs that are still open", async () => {
		const { rerender } = render(tree("req_a"));
		applyModeChange(fresh("req_a"), "graphql");

		await act(async () => useTabsStore.getState().closeTab("tab_b"));

		await act(async () => rerender(tree("req_a")));
		expect(ctx.getAutoMethod()).toEqual({
			requestId: "req_a",
			method: "POST",
			previous: "GET",
		});
	});

	it("keeps the method record of a builder that has no request id", async () => {
		// The History run copy is read-only-ish but still mounts the panels, and it
		// names no tab - so the open-tab bound is not what can decide its records.
		const { rerender } = render(tree(null));
		applyModeChange(fresh(null), "graphql");

		await act(async () => useTabsStore.getState().closeTab("tab_a"));

		await act(async () => rerender(tree(null)));
		expect(ctx.getAutoMethod()).not.toBeNull();
	});
});

describe("a builder that is not a saved request says which one it is", () => {
	/*
	 * Two run tabs, and the copy in each has `id: null` - the gate that stops an
	 * edited copy from rewriting the saved request. Before issue #1272 they were
	 * one identity: both filed under the id-less key, and the rules read a
	 * `requestId` of `null` against another `null` as a match, so the second copy
	 * into GraphQL was handed the first one's record and told it was already in
	 * the mode.
	 */
	const RUN_TABS: Tab[] = [
		{ id: "tab_run_a", type: "run", entityId: "run_a" },
		{ id: "tab_run_b", type: "run", entityId: "run_b" },
	];

	beforeEach(() => {
		useTabsStore.setState({ openTabs: [...RUN_TABS], activeTabId: "tab_run_a" });
	});

	it("gives the second open run tab its own POST and its own record", async () => {
		const { rerender } = render(runTree("run_a"));

		let a = applyModeChange(fresh(null), "graphql");
		expect(headerNames(a)).toEqual(["Content-Type"]);
		expect(a.method).toBe("POST");

		// The other run tab. Same provider instance, same id-less copy - only the
		// declared identity differs, and that is what has to carry it.
		await act(async () => rerender(runTree("run_b")));
		let b = applyModeChange(fresh(null), "graphql");
		expect(headerNames(b)).toEqual(["Content-Type"]);
		expect(b.method).toBe("POST");

		// Each copy leaves the mode on its own record, so the second one going
		// first must not be the first one's exit.
		b = applyModeChange(b, "none");
		expect(headerNames(b)).toEqual([]);
		expect(b.method).toBe("GET");

		// And the first copy can still leave the mode it entered.
		await act(async () => rerender(runTree("run_a")));
		a = applyModeChange(a, "none");
		expect(headerNames(a)).toEqual([]);
		expect(a.method).toBe("GET");
	});

	it("answers with nothing for a run copy that has entered no mode", async () => {
		const { rerender } = render(runTree("run_a"));
		applyModeChange(fresh(null), "graphql");

		await act(async () => rerender(runTree("run_b")));
		expect(ctx.getAutoMethod()).toBeNull();
	});

	it("forgets a run copy's method record when its tab closes", async () => {
		// A declared identity names a tab, so it joins the sweep rather than
		// being exempt from it the way the id-less key has to be.
		const { rerender } = render(runTree("run_a"));
		applyModeChange(fresh(null), "graphql");

		await act(async () => useTabsStore.getState().closeTab("tab_run_a"));

		await act(async () => rerender(runTree("run_a")));
		expect(ctx.getAutoMethod()).toBeNull();
	});

	it("keeps the method record of the run tab that is still open", async () => {
		const { rerender } = render(runTree("run_a"));
		applyModeChange(fresh(null), "graphql");

		await act(async () => useTabsStore.getState().closeTab("tab_run_b"));

		await act(async () => rerender(runTree("run_a")));
		expect(ctx.getAutoMethod()).toEqual({
			requestId: null,
			method: "POST",
			previous: "GET",
		});
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
