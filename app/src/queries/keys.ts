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
		// tab. Its own family keeps the two apart at the root.
		lastDesign: (requestId: string) =>
			[...queryKeys.runs.all, "lastDesign", requestId] as const,
		// The last N design runs of one request, for the context bar's Recent
		// sends section. Its own family for the same reason `lastDesign` has
		// one: it caches a plain `RunListResponse`, and the delete-run patch
		// walks everything under `lists()` as `InfiniteData`. `recentDesigns()`
		// is the prefix to invalidate when the run set changes without a known
		// request (a delete, a history clear).
		recentDesigns: () => [...queryKeys.runs.all, "recentDesign"] as const,
		recentDesign: (requestId: string) =>
			[...queryKeys.runs.recentDesigns(), requestId] as const,
		allRuns: () => [...queryKeys.runs.all, "allRuns"] as const,
		details: () => [...queryKeys.runs.all, "detail"] as const,
		detail: (id: string) => [...queryKeys.runs.details(), id] as const,
		report: (id: string) => [...queryKeys.runs.all, "report", id] as const,
		timeSeries: (id: string) => [...queryKeys.runs.all, "timeSeries", id] as const,
		// Captured response headers/bodies for a run's samples. Its own family,
		// not part of `report`, because it is fetched lazily - only once a
		// reader expands a sample - and must not ride on the report's cache.
		samples: (id: string) => [...queryKeys.runs.all, "samples", id] as const,
	},

	// Warm-cache pass over every collection's requests (see
	// usePrefetchCollectionsAndRequests). Keyed here rather than inline so it
	// can be invalidated when the set of collections changes - it succeeds once
	// and would otherwise never re-run for a collection created mid-session.
	prefetch: {
		all: ["prefetch"] as const,
		allRequests: () => [...queryKeys.prefetch.all, "all-requests"] as const,
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
