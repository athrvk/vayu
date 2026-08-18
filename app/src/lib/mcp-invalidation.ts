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
	 *
	 * `globals` rides on this family rather than getting one of its own (issue
	 * #758): globals are the bottom of the same resolution order the
	 * environments sit in, `update_globals` is the same read-merge-write against
	 * the same variable shape, and the Variables drawer shows them as one more
	 * scope in the same tree. The cost of the pairing is that an
	 * `update_environment` also refetches one small singleton; the cost of
	 * *not* pairing them would have been an entity whose only reader is one
	 * query key, or - worse - an `update_globals` that declared `environment`
	 * and left the globals card showing the pre-write values, which is exactly
	 * the "written but never read" wiring bug this map exists to prevent.
	 */
	environment: (queryClient) => {
		void queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
		void queryClient.invalidateQueries({ queryKey: queryKeys.globals.all });
		void queryClient.invalidateQueries({ queryKey: queryKeys.compose.all });
	},

	/*
	 * The history list polls on its own, so this is about immediacy there - but
	 * `allRuns` (Settings' count) and the four small per-request/per-collection
	 * families are not polled at all, and an MCP write left them stale
	 * indefinitely. They are covered at their prefixes rather than per row: a
	 * run write can change what any of them answers (a delete may have taken the
	 * pin, or the newest send) and the event names at most one request, so the
	 * narrow key would leave whichever list actually moved behind. Each is five
	 * rows, and only the mounted ones refetch - the same trade
	 * `useDeleteRunMutation` makes for the same reason: a run id gives no way
	 * back to the request or collection it belonged to.
	 *
	 * `lastDesigns()` is a prefix for that same reason and takes the same trade
	 * knowingly: `delete_run` and `set_run_baseline` name a `runId` and no
	 * request, so a per-request key could never reach the tab whose run went
	 * away, while a `run_request` now invalidates every open tab's last-design
	 * query rather than the one it ran. Each is a single filtered row, only
	 * mounted tabs refetch, and the alternative is carrying a run-to-request map
	 * purely to patch it.
	 *
	 * Per-run *report* and series keys are still not invalidated wholesale, and
	 * that exclusion is the point: a `run_request` creates a run and cannot have
	 * changed an existing one's report, which is the expensive fetch in this
	 * family. They are dropped only for the one run a call named - see below.
	 */
	run: (queryClient, event) => {
		void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
		void queryClient.invalidateQueries({ queryKey: queryKeys.runs.allRuns() });
		void queryClient.invalidateQueries({ queryKey: queryKeys.runs.baselines() });
		void queryClient.invalidateQueries({ queryKey: queryKeys.runs.recentDesigns() });
		void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lastCollectionRuns() });
		void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lastDesigns() });
		/*
		 * A named run is one that already existed and was rewritten or removed
		 * (`delete_run`, `stop_run`, `set_run_baseline` - the only tools that take
		 * a `runId`). Its per-run caches are `staleTime: Infinity` for the series
		 * and the samples, so invalidation alone would leave a deleted run's
		 * report rendering under an open History tab until it was garbage
		 * collected: they are removed, not marked stale.
		 *
		 * `detail` goes with them deliberately. It is what makes the deleted case
		 * *correct* rather than merely fresh - dropping it lets `runDetailOptions`
		 * refetch, take its 404 and hand `HistoryDetail` the `RunNotFoundError` it
		 * already renders as "This run no longer exists", instead of a pane that
		 * keeps describing a run the sidebar no longer lists.
		 *
		 * The hint says which run changed, not how, so this cannot tell a delete
		 * from a re-pin. That is the accepted cost: after `stop_run` the report
		 * and series genuinely did change (the run went terminal), and after
		 * `set_run_baseline` an open detail pane pays one refetch of data it
		 * already had. A stale answer is a lie; a refetch is a wait.
		 */
		if (event.runId) {
			for (const key of [
				queryKeys.runs.detail(event.runId),
				queryKeys.runs.report(event.runId),
				queryKeys.runs.samples(event.runId),
				queryKeys.runs.timeSeries(event.runId),
				queryKeys.runs.monitorSeries(event.runId),
			]) {
				queryClient.removeQueries({ queryKey: key });
			}
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

	/*
	 * The engine's local services (issues #756, #757). Every list here is polled,
	 * so this is about immediacy in the Services drawer and the Dock's
	 * running-services count - an agent that starts an inbox or a mock and
	 * reports its URL should not be describing a listener the window will not
	 * show for another poll interval.
	 *
	 * All three lists are invalidated on every `service` event rather than one
	 * per kind, because the entity is deliberately one family: the drawer and
	 * the Dock count ask "what is listening", not "which kind" (see
	 * `MCP_DATA_ENTITIES` in `electron/mcp/tools.ts`). Three refetches of a
	 * short list is the price of not carrying a discriminator no reader wants.
	 *
	 * The captures are the half that cannot be handled by invalidation.
	 * `useInboxCapturesQuery` *merges* its fetched page into whatever the cache
	 * holds - three writers feed one entry, so union-by-id is what keeps the SSE
	 * stream and the fetch from overwriting each other - and a union with the
	 * rows a `clear_inbox_captures` just destroyed puts every one of them back.
	 * The app's own clear mutation writes an empty page before refetching for
	 * exactly this reason; from here the equivalent is to drop the entry, so the
	 * merge starts from nothing. A delete needs the same drop for a different
	 * reason: `useDeleteInboxMutation` removes rather than invalidates, because
	 * refetching an id the engine now 404s leaves an error state describing a
	 * list that no longer exists.
	 *
	 * The hint says which inbox a call named, not what it did to it, so a
	 * `update_inbox_response` costs its open tab one refetch of captures it
	 * already had (and any "load more" pages beyond the first). That is the
	 * `run` family's trade taken again and for the same reason: a stale answer
	 * is a lie, a refetch is a wait.
	 *
	 * A mock's route table needs the same drop for the other half of that
	 * reason. `useMockServerRoutesQuery` holds it at `staleTime: Infinity`
	 * because it is a start-time snapshot, so an invalidation would not refetch
	 * it - and after a `stop_mock_server` there is nothing to refetch anyway:
	 * the record dies with the listener and the id now 404s. Dropping the entry
	 * is what `useStopMockServerMutation` already does app-side, for the same
	 * reason `useDeleteInboxMutation` removes rather than invalidates.
	 */
	service: (queryClient, event) => {
		void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.list() });
		void queryClient.invalidateQueries({ queryKey: queryKeys.mockServer.list() });
		void queryClient.invalidateQueries({ queryKey: queryKeys.mockIssuer.list() });
		if (event.inboxId) {
			queryClient.removeQueries({ queryKey: queryKeys.inbox.captures(event.inboxId) });
		}
		if (event.mockId) {
			queryClient.removeQueries({ queryKey: queryKeys.mockServer.routes(event.mockId) });
		}
	},

	/*
	 * The engine's OAuth 2.0 token cache (issue #760). Invalidated at
	 * `oauth.all` rather than at the one key the call named, because the event
	 * carries no cache key: the key an agent clears is an argument, but the key
	 * a `fetch_oauth2_token` writes is derived engine-side and only appears in
	 * the answer, so a per-key hint would be present for one tool and absent for
	 * the other - the shape that leaves a stale row exactly when it matters.
	 * The prefix costs a refetch of every mounted status query, and only an open
	 * Auth tab mounts one.
	 *
	 * The query polls at 30s on its own (`useOAuth2TokenStatusQuery`), so this
	 * is about immediacy in the same way the `service` family is: an agent that
	 * clears a token and says so must not leave the row that shows it valid
	 * standing for another half minute.
	 */
	oauth: (queryClient) => {
		void queryClient.invalidateQueries({ queryKey: queryKeys.oauth.all });
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
