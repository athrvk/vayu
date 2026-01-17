
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
		list: () => [...queryKeys.runs.lists()] as const,
		details: () => [...queryKeys.runs.all, "detail"] as const,
		detail: (id: string) => [...queryKeys.runs.details(), id] as const,
		report: (id: string) => [...queryKeys.runs.all, "report", id] as const,
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
	scriptCompletions: {
		all: ["scriptCompletions"] as const,
	},
} as const;
