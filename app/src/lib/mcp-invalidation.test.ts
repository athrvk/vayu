/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, expect, test, vi, afterEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateForMcpEvent } from "./mcp-invalidation";
import { queryKeys } from "@/queries/keys";
import type { McpDataChangedEvent } from "@/types/domain";

/**
 * Apply one event against a spied client and return what it did.
 *
 * `removed` is kept apart from `keys` because the two are not
 * interchangeable: invalidation leaves the cached answer in place until a
 * refetch replaces it, removal drops it. A run that no longer exists needs the
 * second, and a test that read them as one list could not tell.
 */
function keysFor(event: McpDataChangedEvent) {
	const queryClient = new QueryClient();
	const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
	const removeSpy = vi.spyOn(queryClient, "removeQueries").mockImplementation(() => {});
	const handled = invalidateForMcpEvent(queryClient, event);
	return {
		handled,
		keys: spy.mock.calls.map(([filters]) => filters?.queryKey),
		removed: removeSpy.mock.calls.map(([filters]) => filters?.queryKey),
	};
}

/**
 * The invalidated keys belonging to one family, in order.
 *
 * Several events drop keys from more than one family now, so a whole-list
 * `toEqual` would have to be rewritten every time an unrelated family is added
 * to the same entity - and would stop saying anything about the family it was
 * written for. Reading one prefix keeps "exactly these keys, and no wider one"
 * assertable where that is the actual claim.
 */
function familyOf(keys: (readonly unknown[] | undefined)[], prefix: readonly unknown[]) {
	return keys.filter(
		(key) => Array.isArray(key) && key.length >= prefix.length && key[0] === prefix[0]
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("invalidateForMcpEvent", () => {
	test("a created request invalidates only its own collection's list", () => {
		const { handled, keys } = keysFor({ entity: "request", collectionId: "col_1" });
		expect(handled).toBe(true);
		expect(keys).toContainEqual(queryKeys.requests.listByCollection("col_1"));
		expect(keys).not.toContainEqual(queryKeys.requests.lists());
	});

	test("a request change with no named collection invalidates every list", () => {
		// The owner is unknowable from here, and a per-collection key would leave
		// whichever list actually changed stale.
		const { keys } = keysFor({ entity: "request" });
		expect(keys).toContainEqual(queryKeys.requests.lists());
	});

	test("an updated request also drops its detail cache", () => {
		// `requestDetailOptions` is `staleTime: Infinity`, so a restored tab would
		// otherwise keep serving the copy it read when it opened.
		const { keys } = keysFor({ entity: "request", requestId: "req_3" });
		expect(keys).toContainEqual(queryKeys.requests.detail("req_3"));
	});

	test("a named request reaches its examples, which have no key of their own", () => {
		/*
		 * The MCP example tools (#759) declare the `request` family and name the
		 * request they wrote to. `queryKeys.requests.examples(id)` is nested under
		 * `requests.detail(id)`, so invalidating the detail key covers the open
		 * Examples panel by prefix - no second entity, and no key here that only
		 * these three tools would use. Asserted because the coverage is a
		 * *consequence* of how the key is built: flatten `examples` out from under
		 * `detail` and an example an agent created would never appear in a panel
		 * that was already open.
		 */
		const { keys } = keysFor({ entity: "request", requestId: "req_3" });
		const examples = queryKeys.requests.examples("req_3");
		const detail = keys.find(
			(key) =>
				Array.isArray(key) &&
				key.length <= examples.length &&
				key.every((part, index) => part === examples[index])
		);
		expect(detail).toEqual(queryKeys.requests.detail("req_3"));
	});

	test("a created request touches no detail cache", () => {
		// A create names no request id, and the row it made has no detail entry to
		// invalidate - the narrowing exists for the tools that name one row. Read
		// within the family, because this event also drops keys outside it.
		const { keys } = keysFor({ entity: "request", collectionId: "col_1" });
		expect(familyOf(keys, queryKeys.requests.all)).toEqual([
			queryKeys.requests.listByCollection("col_1"),
		]);
	});

	test("a collection change invalidates collections and every request family", () => {
		// A cascade delete takes descendants and their requests with it, and which
		// rows those were is engine-side knowledge - so both families go wholesale.
		const { keys } = keysFor({ entity: "collection" });
		expect(keys).toContainEqual(queryKeys.collections.all);
		expect(keys).toContainEqual(queryKeys.requests.all);
	});

	test("a deleted request reaches the Trash drawer's list", () => {
		// `delete_request` declares the `request` family alone and stamps a row the
		// drawer lists, exactly as `useDeleteRequestMutation` does app-side. Without
		// this the agent's delete never appears in an open drawer, and the drawer is
		// the only reader this family has.
		const { keys } = keysFor({ entity: "request", requestId: "req_3" });
		expect(keys).toContainEqual(queryKeys.trash.all);
	});

	test("a deleted collection reaches the Trash drawer's list", () => {
		const { keys } = keysFor({ entity: "collection" });
		expect(keys).toContainEqual(queryKeys.trash.all);
	});

	test("a purge that named both families still leaves one trash invalidation per event", () => {
		// `purge_trash_entry` and `restore_trash_entry` declare `collection` and
		// `request`, so the drawer is covered whichever event is read first; each
		// invalidator takes the key once, not once per family it could belong to.
		expect(familyOf(keysFor({ entity: "collection" }).keys, queryKeys.trash.all)).toEqual([
			queryKeys.trash.all,
		]);
		expect(
			familyOf(keysFor({ entity: "request", requestId: "req_3" }).keys, queryKeys.trash.all)
		).toEqual([queryKeys.trash.all]);
	});

	test("a named request drops that request's compositions and no other's", () => {
		/*
		 * The context bar's snippet is built from `POST /compose`, held at
		 * `staleTime: Infinity` and never refetched on its own, so an
		 * `update_request` that changed the URL leaves it describing the pre-write
		 * request. The key is the per-request prefix rather than `compose.all`:
		 * `invalidateQueries` refetches a mounted observer whatever its
		 * `staleTime`, so the wide key would re-compose an open snippet once per
		 * write in an agent's loop over rows it never touched.
		 */
		const { keys } = keysFor({ entity: "request", requestId: "req_3" });
		expect(keys).toContainEqual(queryKeys.compose.allForRequest("req_3"));
		expect(keys).not.toContainEqual(queryKeys.compose.all);
	});

	test("the per-request compose key really is a prefix of the composed entry", () => {
		/*
		 * Asserted against a real client because the coverage is a *consequence* of
		 * how the key is built: `forRequest` appends the environment, so the narrow
		 * key has to reach the entry under whichever environment was active when the
		 * snippet was composed. Flatten the two apart and an agent's edit would
		 * never reach the open Code section.
		 */
		const queryClient = new QueryClient();
		queryClient.setQueryData(queryKeys.compose.forRequest("req_3", "env_1"), { url: "old" });
		queryClient.setQueryData(queryKeys.compose.forRequest("req_other", "env_1"), {
			url: "keep",
		});

		invalidateForMcpEvent(queryClient, { entity: "request", requestId: "req_3" });

		expect(
			queryClient.getQueryState(queryKeys.compose.forRequest("req_3", "env_1"))?.isInvalidated
		).toBe(true);
		expect(
			queryClient.getQueryState(queryKeys.compose.forRequest("req_other", "env_1"))
				?.isInvalidated
		).toBe(false);
	});

	test("a created request composes nothing, so it drops no compose key", () => {
		// `create_request` names no row, and a request that has never been composed
		// has no entry to drop.
		const { keys } = keysFor({ entity: "request", collectionId: "col_1" });
		expect(familyOf(keys, queryKeys.compose.all)).toEqual([]);
	});

	test("a collection change drops every composition under it", () => {
		// A collection write moves the chain its descendants inherit auth, headers
		// and scripts from, and which requests those are is the same engine-side
		// knowledge `requests.all` is taken wholesale for - so the prefix, not a
		// per-request key this event carries no way to build.
		const { keys } = keysFor({ entity: "collection" });
		expect(keys).toContainEqual(queryKeys.compose.all);
	});

	test("a collection change re-runs the warm-cache pass", () => {
		// The pass succeeds once and would stay fresh forever, so a collection an
		// agent created mid-session never gets one - the same invalidation
		// `useCreateCollectionMutation` and `useRestoreTrashMutation` do.
		const { keys } = keysFor({ entity: "collection" });
		expect(keys).toContainEqual(queryKeys.prefetch.allRequests());
	});

	test("a request change leaves the warm-cache pass alone", () => {
		// The pass fans out one list fetch per collection, and the request family is
		// the one an agent loops over row by row. Its two app-side callers scope it
		// to a collection appearing or reappearing, and so does this map.
		const { keys } = keysFor({ entity: "request", requestId: "req_3" });
		expect(keys).not.toContainEqual(queryKeys.prefetch.allRequests());
	});

	test("a config change also drops what a send adds on its own", () => {
		/*
		 * `requestDefaults` is a second endpoint over the same entries, not a slice
		 * of `config`: four of them decide the declared set and the engine resolves
		 * it, so the answer is read rather than derived here.
		 * `useUpdateConfigMutation` drops both keys for that reason, and this map
		 * dropping only `config.all` is what left the Headers tab's "Added by Vayu"
		 * rows listing a header the engine no longer adds.
		 */
		const { keys } = keysFor({ entity: "config" });
		expect(keys).toContainEqual(queryKeys.config.all);
		expect(keys).toContainEqual(queryKeys.requestDefaults.all);
	});

	test("the config event takes both request-default scopes at once", () => {
		// Design and load are separate cache entries (`negotiateCompression` vs
		// `loadNegotiateCompression`), and one write can move both, so the root is
		// the key rather than either scope.
		const queryClient = new QueryClient();
		queryClient.setQueryData(queryKeys.requestDefaults.scope("design"), { headers: [] });
		queryClient.setQueryData(queryKeys.requestDefaults.scope("load"), { headers: [] });

		invalidateForMcpEvent(queryClient, { entity: "config" });

		expect(
			queryClient.getQueryState(queryKeys.requestDefaults.scope("design"))?.isInvalidated
		).toBe(true);
		expect(
			queryClient.getQueryState(queryKeys.requestDefaults.scope("load"))?.isInvalidated
		).toBe(true);
	});

	test("an environment change invalidates the list and the details", () => {
		const { keys } = keysFor({ entity: "environment" });
		expect(keys).toContainEqual(queryKeys.environments.all);
	});

	test("an environment change also drops every composed request", () => {
		// `POST /compose` substitutes environment variables, so an MCP write to
		// them leaves every cached composition - and the curl/fetch snippet the
		// context bar builds from one - describing the pre-write values. Compose is
		// never refetched on its own, so without this the snippet stays wrong until
		// the tab is reopened.
		const { keys } = keysFor({ entity: "environment" });
		expect(keys).toContainEqual(queryKeys.compose.all);
	});

	test("an environment change also takes the globals singleton", () => {
		// `update_globals` (#758) declares the `environment` family, so this key is
		// what makes its write visible: without it the Variables drawer's Globals
		// scope and the resolver keep serving the pre-write values, which is the
		// "written but never read" shape one step removed - the event is emitted,
		// and nothing refetches what it changed.
		const { keys } = keysFor({ entity: "environment" });
		expect(keys).toContainEqual(queryKeys.globals.all);
	});

	test("a run invalidates both list families", () => {
		const { keys } = keysFor({ entity: "run" });
		expect(keys).toContainEqual(queryKeys.runs.lists());
		expect(keys).toContainEqual(queryKeys.runs.allRuns());
	});

	test("a run invalidates the baseline, Recent sends and Last run families", () => {
		// None of the three is polled, and each answers something a run write can
		// move - the pin, the newest send, the collection's last run. Their
		// prefixes because a run id gives no way back to the request or
		// collection, exactly as `useDeleteRunMutation` argues.
		const { keys } = keysFor({ entity: "run" });
		expect(keys).toContainEqual(queryKeys.runs.baselines());
		expect(keys).toContainEqual(queryKeys.runs.recentDesigns());
		expect(keys).toContainEqual(queryKeys.runs.lastCollectionRuns());
	});

	test("a run invalidates the last-design family whether or not it named a request", () => {
		// The tools that take a run away - `delete_run`, `set_run_baseline` -
		// name a `runId` and no request, so the per-request key could never
		// reach the tab whose run went. Every open request tab mounts
		// `useLastDesignRunQuery`, which is what would otherwise go on
		// restoring a deleted run's response.
		expect(keysFor({ entity: "run", runId: "run_1" }).keys).toContainEqual(
			queryKeys.runs.lastDesigns()
		);
		expect(keysFor({ entity: "run", requestId: "req_7" }).keys).toContainEqual(
			queryKeys.runs.lastDesigns()
		);
	});

	test("the last-design prefix is taken instead of the narrower per-request key", () => {
		// Not both: the prefix already covers the row, and a duplicate narrower
		// invalidation is the kind of near-copy that drifts from the prefix.
		const { keys } = keysFor({ entity: "run", requestId: "req_7" });
		expect(keys).not.toContainEqual(queryKeys.runs.lastDesign("req_7"));
	});

	test("a run really does clear an open tab's last-design cache, not just the named request's", () => {
		// Against a real client: the prefix has to match a cache keyed by a
		// request the event never mentioned, which is the whole point of it.
		const queryClient = new QueryClient();
		queryClient.setQueryData(queryKeys.runs.lastDesign("req_other"), { data: [{ id: "r1" }] });

		invalidateForMcpEvent(queryClient, { entity: "run", runId: "run_1" });

		expect(
			queryClient.getQueryState(queryKeys.runs.lastDesign("req_other"))?.isInvalidated
		).toBe(true);
	});

	test("a run that named no id leaves every per-run cache alone", () => {
		// A new run cannot have changed an existing run's report, and those are
		// the expensive fetches in this family.
		const { keys, removed } = keysFor({ entity: "run", requestId: "req_7" });
		expect(keys).not.toContainEqual(queryKeys.runs.report("req_7"));
		expect(keys).not.toContainEqual(queryKeys.runs.all);
		expect(removed).toEqual([]);
	});

	test("a named run has its report, samples, both series and detail removed", () => {
		// Removed rather than invalidated: samples and both series are
		// `staleTime: Infinity`, so a deleted run would go on feeding an open
		// History tab until the entry was garbage collected.
		const { removed } = keysFor({ entity: "run", runId: "run_1" });
		expect(removed).toEqual([
			queryKeys.runs.detail("run_1"),
			queryKeys.runs.report("run_1"),
			queryKeys.runs.samples("run_1"),
			queryKeys.runs.timeSeries("run_1"),
			queryKeys.runs.monitorSeries("run_1"),
		]);
	});

	test("a named run leaves another run's per-run caches untouched", () => {
		// The removal is keyed, not a prefix sweep over `runs.all` - which would
		// take every other run's report with it.
		const { removed } = keysFor({ entity: "run", runId: "run_1" });
		for (const key of removed) {
			expect(key).not.toEqual(queryKeys.runs.all);
			expect(key).toContain("run_1");
		}
		expect(removed).not.toContainEqual(queryKeys.runs.report("run_2"));
	});

	test("a deleted run really is gone from a live cache, not just marked stale", () => {
		// The spied version above proves which keys were named; this proves the
		// call has the effect claimed, against a real QueryClient.
		const queryClient = new QueryClient();
		queryClient.setQueryData(queryKeys.runs.report("run_1"), { id: "run_1" });
		queryClient.setQueryData(queryKeys.runs.samples("run_1"), { id: "run_1" });
		queryClient.setQueryData(queryKeys.runs.report("run_2"), { id: "run_2" });

		invalidateForMcpEvent(queryClient, { entity: "run", runId: "run_1" });

		expect(queryClient.getQueryData(queryKeys.runs.report("run_1"))).toBeUndefined();
		expect(queryClient.getQueryData(queryKeys.runs.samples("run_1"))).toBeUndefined();
		expect(queryClient.getQueryData(queryKeys.runs.report("run_2"))).toEqual({ id: "run_2" });
	});

	test("a cookie change invalidates the single jar key", () => {
		const { keys } = keysFor({ entity: "cookie" });
		expect(keys).toEqual([queryKeys.cookies.all]);
	});

	test("a config change invalidates the config query", () => {
		// The family is taken once and at its root; the sibling key it also drops is
		// a family of its own, asserted above.
		const { keys } = keysFor({ entity: "config" });
		expect(familyOf(keys, queryKeys.config.all)).toEqual([queryKeys.config.all]);
	});

	test("a service change invalidates every service list", () => {
		// One family, three lists: the Services drawer and the Dock count ask
		// "what is listening", not "which kind", so a `service` event has to
		// reach the mock and issuer lists as well as the inbox one (#757).
		const { handled, keys } = keysFor({ entity: "service" });
		expect(handled).toBe(true);
		expect(keys).toEqual([
			queryKeys.inbox.list(),
			queryKeys.mockServer.list(),
			queryKeys.mockIssuer.list(),
		]);
	});

	test("a named inbox has its captures removed, not merely invalidated", () => {
		// `useInboxCapturesQuery` merges a fetched page into what the cache holds,
		// so an invalidation after a clear or a delete would union the destroyed
		// rows straight back. Removal is what makes the refetch start from empty.
		const { removed } = keysFor({ entity: "service", inboxId: "inbox_1" });
		expect(removed).toEqual([queryKeys.inbox.captures("inbox_1")]);
	});

	test("a named mock has its route table removed, not merely invalidated", () => {
		// The table is held at `staleTime: Infinity` (it is a start-time snapshot),
		// so an invalidation would not refetch it - and after a stop the mock's id
		// 404s, so a refetch would leave an error state describing a dead table.
		const { removed } = keysFor({ entity: "service", mockId: "mock_1" });
		expect(removed).toEqual([queryKeys.mockServer.routes("mock_1")]);
	});

	test("a service event that named neither leaves both per-id caches alone", () => {
		const { removed } = keysFor({ entity: "service" });
		expect(removed).toEqual([]);
	});

	test("cleared captures really are gone from a live cache", () => {
		// Against a real QueryClient, since the point is the effect: another
		// inbox's captures must survive, and the named one's must not.
		const queryClient = new QueryClient();
		queryClient.setQueryData(queryKeys.inbox.captures("inbox_1"), { data: [{ id: 1 }] });
		queryClient.setQueryData(queryKeys.inbox.captures("inbox_2"), { data: [{ id: 2 }] });

		invalidateForMcpEvent(queryClient, { entity: "service", inboxId: "inbox_1" });

		expect(queryClient.getQueryData(queryKeys.inbox.captures("inbox_1"))).toBeUndefined();
		expect(queryClient.getQueryData(queryKeys.inbox.captures("inbox_2"))).toEqual({
			data: [{ id: 2 }],
		});
	});

	test("a stopped mock's route table really is gone from a live cache", () => {
		// Same shape as the capture check above, and for the mirror reason: the
		// stopped mock's table must go, another running mock's must survive.
		const queryClient = new QueryClient();
		queryClient.setQueryData(queryKeys.mockServer.routes("mock_1"), { data: [{ path: "/a" }] });
		queryClient.setQueryData(queryKeys.mockServer.routes("mock_2"), { data: [{ path: "/b" }] });

		invalidateForMcpEvent(queryClient, { entity: "service", mockId: "mock_1" });

		expect(queryClient.getQueryData(queryKeys.mockServer.routes("mock_1"))).toBeUndefined();
		expect(queryClient.getQueryData(queryKeys.mockServer.routes("mock_2"))).toEqual({
			data: [{ path: "/b" }],
		});
	});

	test("an oauth change invalidates the token-status family", () => {
		const { handled, keys } = keysFor({ entity: "oauth" });
		expect(handled).toBe(true);
		expect(keys).toEqual([queryKeys.oauth.all]);
	});

	test("the prefix reaches a status query cached under any key", () => {
		// The event carries no cache key - a fetch's key is derived engine-side
		// and appears only in the answer - so the prefix has to cover an entry
		// stored under a key this side never saw.
		const queryClient = new QueryClient();
		const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
		queryClient.setQueryData(queryKeys.oauth.token("some-engine-derived-key"), {
			found: true,
		});

		invalidateForMcpEvent(queryClient, { entity: "oauth" });

		const [filters] = spy.mock.calls[0];
		expect(
			queryClient
				.getQueryCache()
				.findAll(filters)
				.map((q) => q.queryKey)
		).toContainEqual(queryKeys.oauth.token("some-engine-derived-key"));
	});

	test("an unknown entity is reported, not thrown", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { handled, keys } = keysFor({
			entity: "sasquatch",
		} as unknown as McpDataChangedEvent);
		expect(handled).toBe(false);
		expect(keys).toEqual([]);
		expect(warn).toHaveBeenCalled();
	});
});
