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

	// Saved example responses, nested under their request (issue #481). Nested
	// rather than a top-level `/examples?requestId=` because an example is owned
	// by exactly one request - the engine checks the owner before the example.
	// Only the list path: examples arrive by import in this phase, so the
	// engine's per-example POST/PUT/DELETE have no caller here yet and a
	// constant with no reader is the defect this repo keeps finding.
	REQUEST_EXAMPLES: (requestId: string) => `/requests/${requestId}/examples`,

	// Batch reorder for both entity kinds (issue #365). One drop is one call and
	// one engine transaction; a reorder expressed as N sibling PUTs is neither.
	REORDER: `/reorder`,

	// Environments
	ENVIRONMENTS: `/environments`,
	ENVIRONMENT_BY_ID: (id: string) => `/environments/${id}`,
	ENVIRONMENTS_UPDATE: (id: string) => `/environments/${id}`,

	// Global Variables
	GLOBALS: `/globals`,

	// Cookie jar (issue #301). GET reads every jar; DELETE clears one or all -
	// its `environmentId` parameter follows the engine's null-vs-absent rule,
	// so omitting it clears every jar and sending it empty clears the one used
	// by requests with no environment selected.
	COOKIES: `/cookies`,

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
		collectionId?: string;
		q?: string;
		baseline?: boolean;
	}) => {
		const qs = new URLSearchParams();
		if (params.limit !== undefined) qs.set("limit", String(params.limit));
		if (params.offset !== undefined) qs.set("offset", String(params.offset));
		if (params.type) qs.set("type", params.type);
		if (params.status) qs.set("status", params.status);
		if (params.requestId) qs.set("requestId", params.requestId);
		if (params.collectionId) qs.set("collectionId", params.collectionId);
		if (params.q) qs.set("q", params.q);
		// Tested for `undefined` rather than truthiness: `baseline: false` is a
		// real question ("the runs that are not pinned"), and a falsy check
		// would drop it and answer with every run instead.
		if (params.baseline !== undefined) qs.set("baseline", String(params.baseline));
		const s = qs.toString();
		return s ? `/runs?${s}` : `/runs`;
	},
	RUN_BY_ID: (id: string) => `/runs/${id}`,
	/** Pin or unpin a run as the baseline later runs are compared against. */
	RUN_BASELINE: (id: string) => `/runs/${id}/baseline`,
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

	// Server vitals scraped during the run (JSON, paginated, same envelope).
	// Its own endpoint rather than extra keys on the tick objects: those keys
	// are the /metrics contract, and scrapes land on the user's own cadence.
	RUN_MONITOR: (runId: string, limit = STATS_PAGE_LIMIT, offset = 0) =>
		`/runs/${runId}/monitor?limit=${limit}&offset=${offset}`,

	// Import. FETCH proxies a remote collection past CORS; APPLY persists the
	// whole parsed tree in one atomic call and returns the temp-id -> real-id map
	// (the import path no longer creates items one POST at a time).
	IMPORT_FETCH: `/import/fetch`,
	IMPORT_APPLY: `/import/apply`,

	// Webhook inbox (issue #480). The engine hosts the listener; these drive its
	// lifecycle and read what it captured. START is a verb path rather than a
	// POST to `/inbox` because an inbox is not a stored resource - it exists for
	// as long as the engine process does, so the create/update split #95 draws
	// for collections and requests does not apply.
	INBOX: `/inbox`,
	INBOX_START: `/inbox/start`,
	INBOX_STOP: (inboxId: string) => `/inbox/${inboxId}/stop`,
	INBOX_BY_ID: (inboxId: string) => `/inbox/${inboxId}`,
	INBOX_CAPTURES: (inboxId: string, limit: number, offset: number) =>
		`/inbox/${inboxId}/requests?limit=${limit}&offset=${offset}`,
	INBOX_CAPTURES_CLEAR: (inboxId: string) => `/inbox/${inboxId}/requests`,
	INBOX_LIVE: (inboxId: string) => `/inbox/${inboxId}/live`,

	// OAuth 2.0 mock issuer (issue #479). Engine-process state like an inbox, so
	// the same verb-path shape: START creates one, the id paths update and stop
	// it. There is no DELETE - stopping is what ends an issuer, and the record
	// goes with it (unlike an inbox, which stays readable once stopped).
	MOCK_ISSUER: `/mock-issuer`,
	MOCK_ISSUER_START: `/mock-issuer/start`,
	MOCK_ISSUER_BY_ID: (issuerId: string) => `/mock-issuer/${issuerId}`,
	MOCK_ISSUER_STOP: (issuerId: string) => `/mock-issuer/${issuerId}/stop`,

	// OAuth 2.0
	OAUTH2_TOKEN: `/oauth2/token`,
	OAUTH2_AUTHORIZE_START: `/oauth2/authorize/start`,
	OAUTH2_AUTHORIZE_COMPLETE: `/oauth2/authorize/complete`,
	OAUTH2_AUTHORIZE_STATUS: (attemptId: string) => `/oauth2/authorize/${attemptId}`,
} as const;
