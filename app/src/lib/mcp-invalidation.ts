/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * MCP data-change invalidation.
 *
 * An MCP tool call mutates the engine from the Electron main process, so the
 * renderer's caches have no way to notice: `refetchOnWindowFocus` is off
 * app-wide (see `lib/query-client.ts`), and until now nothing crossed the
 * process boundary. The main process sends one `mcp:data-changed` per family a
 * successful call touched; this maps that family to the query keys that read it.
 *
 * Invalidation only - no engine data rides over IPC, so there is exactly one
 * path by which a row reaches the UI and it is the query layer.
 */

import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/queries/keys";
import type { McpDataChangedEvent, McpDataEntity } from "@/types/domain";

/**
 * Which caches each family invalidates.
 *
 * A `Record` over the union rather than a `switch`: a new entity added to
 * `McpDataEntity` fails to compile until it names a reader here, which is the
 * check that keeps this from becoming a channel that writes events nothing
 * listens for.
 */
const INVALIDATORS: Record<
	McpDataEntity,
	(queryClient: QueryClient, event: McpDataChangedEvent) => void
> = {
	/*
	 * A collection write is taken coarsely, the way `useDeleteCollectionMutation`
	 * takes it: `delete_collection` cascades through every descendant collection
	 * and every request inside them, and which rows those are is engine-side
	 * knowledge - a client that re-derived the subtree would drift from the
	 * engine's definition of "descendant". `requests.all` rather than a list key
	 * because `requests.detail` entries carry `staleTime: Infinity`, so a deleted
	 * request would otherwise stay fresh forever and keep feeding restored tabs.
	 */
	collection: (queryClient) => {
		void queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
		void queryClient.invalidateQueries({ queryKey: queryKeys.requests.all });
	},

	/*
	 * The tree reads one list per collection, so a created request only needs its
	 * owner's list - the same narrowing `useUpdateRequestMutation` does rather
	 * than refetching every collection on one row's change. Without a named
	 * collection the owner is unknowable from here, so the whole `lists()` prefix
	 * goes; that prefix also covers the reorder pass, which reads at `lists()`
	 * itself and would be missed by a per-collection key alone.
	 *
	 * A named `requestId` also takes that row's detail cache, which the lists do
	 * not cover: `requestDetailOptions` is `staleTime: Infinity`, so an updated
	 * or deleted request would keep feeding a restored tab the copy it read on
	 * open. Only the tools that name one row (`update_request`, `delete_request`)
	 * carry the hint; `create_request` names none, and its row has no detail
	 * entry yet.
	 */
	request: (queryClient, event) => {
		void queryClient.invalidateQueries({
			queryKey: event.collectionId
				? queryKeys.requests.listByCollection(event.collectionId)
				: queryKeys.requests.lists(),
		});
		if (event.requestId) {
			void queryClient.invalidateQueries({
				queryKey: queryKeys.requests.detail(event.requestId),
			});
		}
	},

	/*
	 * `all`, not `list()`: an environment's variables are read through the detail
	 * cache as well as the list, and `update_environment` changes exactly those.
	 *
	 * `compose` too, and at the `all` prefix rather than the written environment's
	 * key: `POST /compose` substitutes those same variables, so a composition -
	 * and the curl/fetch snippet the context bar builds from one - is built from
	 * the pre-write values. The prefix, because a request composed against a
	 * *different* environment still reads the globals this write may have
	 * shadowed. Nothing refetches compose on its own, so a miss here is stale
	 * until the tab is reopened.
	 */
	environment: (queryClient) => {
		void queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
		void queryClient.invalidateQueries({ queryKey: queryKeys.compose.all });
	},

	/*
	 * The history list polls on its own, so this is about immediacy there - but
	 * `allRuns` (Settings' count), `lastDesign` (a request tab's restored
	 * response) and `recentDesign` (its Recent sends section) are not polled at
	 * all, and an MCP-run request left them stale indefinitely. Reports and time
	 * series are keyed per run and describe runs that already existed, so they
	 * are deliberately not touched.
	 */
	run: (queryClient, event) => {
		void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
		void queryClient.invalidateQueries({ queryKey: queryKeys.runs.allRuns() });
		if (event.requestId) {
			void queryClient.invalidateQueries({
				queryKey: queryKeys.runs.lastDesign(event.requestId),
			});
			void queryClient.invalidateQueries({
				queryKey: queryKeys.runs.recentDesign(event.requestId),
			});
		}
	},

	/*
	 * One key for every jar - the engine reports them together and the panel
	 * shows them together (see `queries/cookies.ts`).
	 */
	cookie: (queryClient) => {
		void queryClient.invalidateQueries({ queryKey: queryKeys.cookies.all });
	},

	config: (queryClient) => {
		void queryClient.invalidateQueries({ queryKey: queryKeys.config.all });
	},
};

/**
 * Apply one `mcp:data-changed` event.
 *
 * An unknown entity is dropped rather than thrown: the event crosses a process
 * boundary, so a main process newer than the renderer bundle (a hot reload
 * against a rebuilt main) can legitimately name a family this build has never
 * heard of, and losing one invalidation is a stale list while throwing inside
 * an IPC listener is an unhandled rejection with the same stale list.
 */
export function invalidateForMcpEvent(
	queryClient: QueryClient,
	event: McpDataChangedEvent
): boolean {
	const invalidate = INVALIDATORS[event.entity];
	if (!invalidate) {
		console.warn("[MCP] Ignoring data-changed event for unknown entity:", event.entity);
		return false;
	}
	invalidate(queryClient, event);
	return true;
}
