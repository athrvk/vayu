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

import { ENGINE_BASE_URL, STATS_PAGE_LIMIT } from "./network";

const BASE_URL = ENGINE_BASE_URL;

export const API_ENDPOINTS = {
	// Base
	BASE_URL,

	// Health & Config
	HEALTH: `/health`,
	CONFIG: `/config`,

	// Collections. POST the collection path to create; PUT the by-id path to
	// update. The engine split the verbs in #95 - POST no longer upserts, so an
	// update sent as a POST is a 409, and a create sent as a PUT is a 404.
	COLLECTIONS: `/collections`,
	COLLECTION_BY_ID: (id: string) => `/collections/${id}`,
	COLLECTIONS_UPDATE: (id: string) => `/collections/${id}`,

	// Requests
	REQUESTS: `/requests`,
	REQUEST_BY_ID: (id: string) => `/requests/${id}`,
	REQUESTS_UPDATE: (id: string) => `/requests/${id}`,

	// Environments
	ENVIRONMENTS: `/environments`,
	ENVIRONMENT_BY_ID: (id: string) => `/environments/${id}`,
	ENVIRONMENTS_UPDATE: (id: string) => `/environments/${id}`,

	// Global Variables
	GLOBALS: `/globals`,

	// Scripting
	SCRIPT_COMPLETIONS: `/scripting/completions`,
	SCRIPT_TYPES: `/scripting/types`,

	// Execution
	// Composition first, execution second: POST /compose resolves {{variables}}
	// and inherit auth engine-side and returns the payload the two execution
	// endpoints accept unchanged (issue #226).
	COMPOSE_REQUEST: `/compose`,
	EXECUTE_REQUEST: `/execute`,
	START_LOAD_TEST: `/runs`,

	// Runs
	RUNS: `/runs`,
	// Paginated, filtered list. Passing any param opts into the `{data,
	// pagination}` envelope; a bare `/runs` (no params) still returns the
	// legacy bare array (removed next minor).
	RUNS_LIST: (params: {
		limit?: number;
		offset?: number;
		type?: string;
		status?: string;
		requestId?: string;
		q?: string;
	}) => {
		const qs = new URLSearchParams();
		if (params.limit !== undefined) qs.set("limit", String(params.limit));
		if (params.offset !== undefined) qs.set("offset", String(params.offset));
		if (params.type) qs.set("type", params.type);
		if (params.status) qs.set("status", params.status);
		if (params.requestId) qs.set("requestId", params.requestId);
		if (params.q) qs.set("q", params.q);
		const s = qs.toString();
		return s ? `/runs?${s}` : `/runs`;
	},
	RUN_BY_ID: (id: string) => `/runs/${id}`,
	RUN_REPORT: (id: string) => `/runs/${id}/report`,
	RUN_STOP: (id: string) => `/runs/${id}/stop`,
	// The response headers and body captured for a run's retained samples.
	// Separate from the report on purpose: the report path loads and parses
	// every result row for a run on each fetch and the dashboard polls it, so
	// bodies are fetched here instead, only when a sample is expanded.
	RUN_SAMPLES: (id: string, limit: number, offset: number) =>
		`/runs/${id}/samples?limit=${limit}&offset=${offset}`,

	// Real-time stats (SSE, memory-based, faster)
	METRICS_LIVE: (runId: string) => `/runs/${runId}/live`,

	// Time-series metrics (JSON, paginated). Always JSON - no format param.
	STATS_TIME_SERIES: (runId: string, limit = STATS_PAGE_LIMIT, offset = 0) =>
		`/runs/${runId}/metrics?limit=${limit}&offset=${offset}`,

	// Import. FETCH proxies a remote collection past CORS; APPLY persists the
	// whole parsed tree in one atomic call and returns the temp-id -> real-id map
	// (the import path no longer creates items one POST at a time).
	IMPORT_FETCH: `/import/fetch`,
	IMPORT_APPLY: `/import/apply`,

	// OAuth 2.0
	OAUTH2_TOKEN: `/oauth2/token`,
	OAUTH2_AUTHORIZE_START: `/oauth2/authorize/start`,
	OAUTH2_AUTHORIZE_COMPLETE: `/oauth2/authorize/complete`,
	OAUTH2_AUTHORIZE_STATUS: (attemptId: string) => `/oauth2/authorize/${attemptId}`,
} as const;
