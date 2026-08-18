/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Query Keys
 *
 * Centralized query key factory for type-safe, consistent cache keys.
 * Following TanStack Query best practices for query key management.
 */

export const queryKeys = {
	// Collections
	collections: {
		all: ["collections"] as const,
		lists: () => [...queryKeys.collections.all, "list"] as const,
		list: () => [...queryKeys.collections.lists()] as const,
		details: () => [...queryKeys.collections.all, "detail"] as const,
		detail: (id: string) => [...queryKeys.collections.details(), id] as const,
	},

	// Requests (within collections)
	requests: {
		all: ["requests"] as const,
		lists: () => [...queryKeys.requests.all, "list"] as const,
		listByCollection: (collectionId: string) =>
			[...queryKeys.requests.lists(), { collectionId }] as const,
		details: () => [...queryKeys.requests.all, "detail"] as const,
		detail: (id: string) => [...queryKeys.requests.details(), id] as const,
		// Saved example responses (issue #481). Under the request's own prefix
		// because they are owned by it: invalidating a request's subtree drops
		// its examples with it, which is what a delete needs.
		examples: (id: string) => [...queryKeys.requests.detail(id), "examples"] as const,
	},

	// Runs (history)
	runs: {
		all: ["runs"] as const,
		lists: () => [...queryKeys.runs.all, "list"] as const,
		// Paginated list cache is keyed by its server-side filters (q), so
		// different searches cache separately. `lists()` is the prefix used to
		// invalidate/patch every variant at once.
		list: (filters: Record<string, unknown> = {}) =>
			[...queryKeys.runs.lists(), filters] as const,
		// The last completed design run for a request is one row cached as a
		// plain `RunListResponse`, so it must NOT sit under `lists()`: the
		// delete-run patch walks every cache under that prefix as `InfiniteData`
		// and threw on this shape (`old.pages` undefined) for any open request
		// tab. Its own family keeps the two apart at the root. `lastDesigns()`
		// is the prefix to invalidate when the run set changes without a known
		// request (a delete, a history clear): a run id gives no way back to the
		// request the run belonged to, and `RequestBuilderProvider` mounts this
		// query for every open request tab, so without the prefix a deleted run
		// goes on being restored into one.
		lastDesigns: () => [...queryKeys.runs.all, "lastDesign"] as const,
		lastDesign: (requestId: string) => [...queryKeys.runs.lastDesigns(), requestId] as const,
		// The last N design runs of one request, for the context bar's Recent
		// sends section. Its own family for the same reason `lastDesign` has
		// one: it caches a plain `RunListResponse`, and the delete-run patch
		// walks everything under `lists()` as `InfiniteData`. `recentDesigns()`
		// is the prefix to invalidate when the run set changes without a known
		// request (a delete, a history clear).
		recentDesigns: () => [...queryKeys.runs.all, "recentDesign"] as const,
		recentDesign: (requestId: string) =>
			[...queryKeys.runs.recentDesigns(), requestId] as const,
		// The most recent collection run of one collection, for the context
		// bar's Last run section. Its own family for the third time and the same
		// reason as the two above: it caches a plain `RunListResponse`, and the
		// delete-run patch walks everything under `lists()` as `InfiniteData`.
		// `lastCollectionRuns()` is the prefix to invalidate when the run set
		// changes without a known collection (a delete, a history clear).
		lastCollectionRuns: () => [...queryKeys.runs.all, "lastCollectionRun"] as const,
		lastCollectionRun: (collectionId: string) =>
			[...queryKeys.runs.lastCollectionRuns(), collectionId] as const,
		// The run pinned as baseline for one request, for the history view's
		// vs-baseline strip. Its own family for the fourth time and the same
		// reason as the three above: it caches a plain `RunListResponse`, and
		// the delete-run patch walks everything under `lists()` as
		// `InfiniteData`. `baselines()` is the prefix to invalidate when a pin
		// moves, or when the run set changes without a known request.
		baselines: () => [...queryKeys.runs.all, "baseline"] as const,
		baseline: (requestId: string) => [...queryKeys.runs.baselines(), requestId] as const,
		// One small page of runs matching a palette query. Its own family for the
		// fifth time and the same reason as the four above: it caches a plain
		// `RunListResponse`, and the delete-run patch walks everything under
		// `lists()` as `InfiniteData`.
		searches: () => [...queryKeys.runs.all, "search"] as const,
		search: (q: string) => [...queryKeys.runs.searches(), q] as const,
		allRuns: () => [...queryKeys.runs.all, "allRuns"] as const,
		details: () => [...queryKeys.runs.all, "detail"] as const,
		detail: (id: string) => [...queryKeys.runs.details(), id] as const,
		report: (id: string) => [...queryKeys.runs.all, "report", id] as const,
		timeSeries: (id: string) => [...queryKeys.runs.all, "timeSeries", id] as const,
		// The run's scraped server vitals - its own family, cached like the time
		// series (a finished run's samples never change).
		monitorSeries: (id: string) => [...queryKeys.runs.all, "monitorSeries", id] as const,
		// Captured response headers/bodies for a run's samples. Its own family,
		// not part of `report`, because it is fetched lazily - only once a
		// reader expands a sample - and must not ride on the report's cache.
		samples: (id: string) => [...queryKeys.runs.all, "samples", id] as const,
	},

	// Webhook inboxes (issue #480). Engine-process state, not stored records -
	// `list` is every inbox this engine has started, `captures` is one inbox's
	// recorded requests, kept apart because the live stream invalidates only
	// the second.
	inbox: {
		all: ["inbox"] as const,
		list: () => [...queryKeys.inbox.all, "list"] as const,
		captures: (inboxId: string) => [...queryKeys.inbox.all, "captures", inboxId] as const,
	},

	// OAuth 2.0 mock issuers (issue #479). One key: the engine reports every
	// running issuer in one call and there is no per-issuer read - stopping one
	// removes it from the same list.
	mockIssuer: {
		all: ["mockIssuer"] as const,
		list: () => [...queryKeys.mockIssuer.all, "list"] as const,
	},

	// Collection mock servers (issue #481 phase 2). `list` is every running
	// mock; `routes` is one mock's table, kept apart because the table is a
	// start-time snapshot that never changes under a running mock - so it is
	// fetched once per mock rather than riding on the list's poll.
	mockServer: {
		all: ["mockServer"] as const,
		list: () => [...queryKeys.mockServer.all, "list"] as const,
		routes: (mockId: string) => [...queryKeys.mockServer.all, "routes", mockId] as const,
	},

	// Warm-cache pass over every collection's requests (see
	// usePrefetchCollectionsAndRequests). Keyed here rather than inline so it
	// can be invalidated when the set of collections changes - it succeeds once
	// and would otherwise never re-run for a collection created mid-session.
	prefetch: {
		all: ["prefetch"] as const,
		allRequests: () => [...queryKeys.prefetch.all, "all-requests"] as const,
	},

	// Stored OpenAPI documents (issue #637). Only a by-id read: the engine has no
	// list route, and a spec is reached through the collection that binds it.
	specs: {
		all: ["specs"] as const,
		detail: (id: string) => [...queryKeys.specs.all, "detail", id] as const,
		// The same document described rather than transferred (issue #712), under
		// its own key because it is a different shape of answer: a cached `meta`
		// must never satisfy a reader that needs `content`, and one document in
		// two caches is safe precisely because both are immutable - a changed
		// document is a new id.
		meta: (id: string) => [...queryKeys.specs.all, "meta", id] as const,
	},

	// Environments
	environments: {
		all: ["environments"] as const,
		lists: () => [...queryKeys.environments.all, "list"] as const,
		list: () => [...queryKeys.environments.lists()] as const,
		details: () => [...queryKeys.environments.all, "detail"] as const,
		detail: (id: string) => [...queryKeys.environments.details(), id] as const,
	},

	// Global Variables
	globals: {
		all: ["globals"] as const,
	},

	// Cookie jar. One key for the whole read - the engine reports every scope
	// in one call, and the panel shows them together.
	cookies: {
		all: ["cookies"] as const,
	},

	// Client-certificate registry (issue #707)
	clientCertificates: {
		all: ["clientCertificates"] as const,
	},

	// Health
	health: {
		all: ["health"] as const,
		status: () => [...queryKeys.health.all, "status"] as const,
	},

	// Config
	config: {
		all: ["config"] as const,
	},

	// Script Completions
	scriptTypes: {
		all: ["scriptTypes"] as const,
	},

	scriptCompletions: {
		all: ["scriptCompletions"] as const,
	},

	// `POST /compose` for a stored request - what will actually be sent, with
	// variables substituted and `inherit` auth walked. Keyed by environment as
	// well as request: the same request composes differently per environment,
	// and one key for both would serve the wrong snippet after a switch.
	compose: {
		all: ["compose"] as const,
		forRequest: (requestId: string, environmentId: string | null) =>
			[...queryKeys.compose.all, requestId, environmentId] as const,
	},

	// OAuth 2.0 token cache
	oauth: {
		all: ["oauth2"] as const,
		token: (cacheKey: string) => [...queryKeys.oauth.all, "token", cacheKey] as const,
	},
} as const;
