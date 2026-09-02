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
 * One provider serves every request tab, so what the three reversible-setting
 * records are keyed by is a property of the provider, not of the rules that
 * read them (issue #1269).
 *
 * The rules themselves are tested as logic - `utils/auto-header.test.ts`,
 * `panels/body/graphql-method.test.ts` - and cannot see this: each is handed a
 * record and answers for it. What could not be seen from there is that a second
 * request entering the same mode used to overwrite the first request's record,
 * leaving the first with a header row, or a method, the app had changed for it
 * and nothing left that knew it was the app's.
 *
 * The panels are stood in for rather than driven, as in
 * `body-drafts-lifetime.test.tsx`: `BodyPanel` only writes when a Radix
 * `Select` commits, and a Select does not commit in jsdom. `applyModeChange`
 * and `applyStreamToggle` below make exactly the calls the panels make, in the
 * same order, through the real rules.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { useEffect } from "react";
import { render, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import { switchContentType } from "../components/RequestTabs/panels/body/content-type";
import { switchGraphQLMethod } from "../components/RequestTabs/panels/body/graphql-method";
import { switchAutoHeader } from "../utils/auto-header";
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

/** Just enough of a request for the two rules under test. */
interface Draft {
	id: string | null;
	headers: KeyValueItem[];
	method: HttpMethod;
	stream: boolean;
}

const fresh = (id: string | null): Draft => ({ id, headers: [], method: "GET", stream: false });

/** The two writes `BodyPanel.handleModeChange` makes, in its order. */
function applyModeChange(draft: Draft, mode: BodyMode): Draft {
	const contentType = switchContentType(mode, draft.headers, draft.id, ctx.getAutoContentType());
	ctx.setAutoContentType(contentType.auto);

	const graphqlMethod = switchGraphQLMethod(mode, draft.method, draft.id, ctx.getAutoMethod());
	ctx.setAutoMethod(graphqlMethod.auto);

	return { ...draft, headers: contentType.headers, method: graphqlMethod.method };
}

/** The write `SettingsPanel.handleStreamChange` makes for the Event stream toggle. */
function applyStreamToggle(draft: Draft, stream: boolean): Draft {
	const next = switchAutoHeader(
		"Accept",
		stream ? "text/event-stream" : null,
		draft.headers,
		draft.id,
		ctx.getAutoAccept()
	);
	ctx.setAutoAccept(next.auto);
	return { ...draft, headers: next.headers, stream };
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
		// serves both tabs, so B's records land in the same three slots.
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

	it("keeps the Event stream toggle's Accept row reversible on the request that armed it", async () => {
		const { rerender } = render(tree("req_a"));

		let a = applyStreamToggle(fresh("req_a"), true);
		expect(headerNames(a)).toEqual(["Accept"]);

		await act(async () => rerender(tree("req_b")));
		applyStreamToggle(fresh("req_b"), true);

		await act(async () => rerender(tree("req_a")));
		a = applyStreamToggle(a, false);
		expect(headerNames(a)).toEqual([]);
	});

	it("answers with nothing for a request that has entered no mode", async () => {
		// Guards the two cases above: they would also pass if every request read
		// one shared record back.
		const { rerender } = render(tree("req_a"));
		applyModeChange(fresh("req_a"), "graphql");

		await act(async () => rerender(tree("req_b")));
		expect(ctx.getAutoContentType()).toBeNull();
		expect(ctx.getAutoMethod()).toBeNull();
	});
});

describe("what bounds the records", () => {
	it("forgets a request's records when its tab closes", async () => {
		const { rerender } = render(tree("req_a"));
		applyModeChange(fresh("req_a"), "graphql");
		applyStreamToggle(fresh("req_a"), true);

		await act(async () => useTabsStore.getState().closeTab("tab_a"));

		await act(async () => rerender(tree("req_a")));
		expect(ctx.getAutoContentType()).toBeNull();
		expect(ctx.getAutoAccept()).toBeNull();
		expect(ctx.getAutoMethod()).toBeNull();
	});

	it("keeps the records of the tabs that are still open", async () => {
		const { rerender } = render(tree("req_a"));
		const a = applyModeChange(fresh("req_a"), "graphql");

		await act(async () => useTabsStore.getState().closeTab("tab_b"));

		await act(async () => rerender(tree("req_a")));
		expect(ctx.getAutoContentType()).toEqual({
			requestId: "req_a",
			rowId: a.headers[0].id,
			value: "application/json",
		});
	});

	it("keeps the records of a builder that has no request id", async () => {
		// The History run copy is read-only-ish but still mounts the panels, and it
		// names no tab - so the open-tab bound is not what can decide its records.
		const { rerender } = render(tree(null));
		applyModeChange(fresh(null), "graphql");

		await act(async () => useTabsStore.getState().closeTab("tab_a"));

		await act(async () => rerender(tree(null)));
		expect(ctx.getAutoContentType()).not.toBeNull();
	});
});
