
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * API Endpoints Configuration
 *
 * All backend API endpoints in one place.
 * Change these if the backend API routes change.
 */

// Remote URLs (for reference)
// const BASE_URL = "https://71bb7ff8ef44.ngrok-free.app";
// const BASE_URL = "https://vayu-engine-latest.onrender.com";

// Local development
const BASE_URL = "http://127.0.0.1:9876";

export const API_ENDPOINTS = {
	// Base
	BASE_URL,

	// Health & Config
	HEALTH: `/health`,
	CONFIG: `/config`,

	// Collections
	COLLECTIONS: `/collections`,
	COLLECTION_BY_ID: (id: string) => `/collections/${id}`,

	// Requests
	REQUESTS: `/requests`,
	REQUEST_BY_ID: (id: string) => `/requests/${id}`,

	// Environments
	ENVIRONMENTS: `/environments`,
	ENVIRONMENT_BY_ID: (id: string) => `/environments/${id}`,

	// Global Variables
	GLOBALS: `/globals`,

	// Scripting
	SCRIPT_COMPLETIONS: `/scripting/completions`,

	// Execution
	EXECUTE_REQUEST: `/request`,
	START_LOAD_TEST: `/run`,

	// Runs
	RUNS: `/runs`,
	RUN_BY_ID: (id: string) => `/run/${id}`,
	RUN_REPORT: (id: string) => `/run/${id}/report`,
	RUN_STOP: (id: string) => `/run/${id}/stop`,

	// Real-time stats (SSE)
	STATS_STREAM: (runId: string) => `/stats/${runId}`, // Old endpoint (DB-based)
	METRICS_LIVE: (runId: string) => `/metrics/live/${runId}`, // New endpoint (memory-based, faster)

	// Time-series metrics (JSON, paginated)
	STATS_TIME_SERIES: (runId: string, limit = 5000, offset = 0) =>
		`/stats/${runId}?format=json&limit=${limit}&offset=${offset}`,
} as const;
