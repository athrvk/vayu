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

afterEach(() => {
	vi.restoreAllMocks();
});

describe("invalidateForMcpEvent", () => {
	test("a created request invalidates only its own collection's list", () => {
		const { handled, keys } = keysFor({ entity: "request", collectionId: "col_1" });
		expect(handled).toBe(true);
		expect(keys).toEqual([queryKeys.requests.listByCollection("col_1")]);
	});

	test("a request change with no named collection invalidates every list", () => {
		// The owner is unknowable from here, and a per-collection key would leave
		// whichever list actually changed stale.
		const { keys } = keysFor({ entity: "request" });
		expect(keys).toEqual([queryKeys.requests.lists()]);
	});

	test("an updated request also drops its detail cache", () => {
		// `requestDetailOptions` is `staleTime: Infinity`, so a restored tab would
		// otherwise keep serving the copy it read when it opened.
		const { keys } = keysFor({ entity: "request", requestId: "req_3" });
		expect(keys).toContainEqual(queryKeys.requests.detail("req_3"));
	});

	test("a created request touches no detail cache", () => {
		// A create names no request id, and the row it made has no detail entry to
		// invalidate - the narrowing exists for the tools that name one row.
		const { keys } = keysFor({ entity: "request", collectionId: "col_1" });
		expect(keys).toEqual([queryKeys.requests.listByCollection("col_1")]);
	});

	test("a collection change invalidates collections and every request family", () => {
		// A cascade delete takes descendants and their requests with it, and which
		// rows those were is engine-side knowledge - so both families go wholesale.
		const { keys } = keysFor({ entity: "collection" });
		expect(keys).toEqual([queryKeys.collections.all, queryKeys.requests.all]);
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

	test("a run linked to a saved request also invalidates its last design run", () => {
		const { keys } = keysFor({ entity: "run", requestId: "req_7" });
		expect(keys).toContainEqual(queryKeys.runs.lastDesign("req_7"));
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
		const { keys } = keysFor({ entity: "config" });
		expect(keys).toEqual([queryKeys.config.all]);
	});

	test("a service change invalidates the inbox list", () => {
		const { handled, keys } = keysFor({ entity: "service" });
		expect(handled).toBe(true);
		expect(keys).toEqual([queryKeys.inbox.list()]);
	});

	test("a named inbox has its captures removed, not merely invalidated", () => {
		// `useInboxCapturesQuery` merges a fetched page into what the cache holds,
		// so an invalidation after a clear or a delete would union the destroyed
		// rows straight back. Removal is what makes the refetch start from empty.
		const { keys, removed } = keysFor({ entity: "service", inboxId: "inbox_1" });
		expect(keys).toEqual([queryKeys.inbox.list()]);
		expect(removed).toEqual([queryKeys.inbox.captures("inbox_1")]);
	});

	test("a service event that named no inbox leaves every capture list alone", () => {
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
