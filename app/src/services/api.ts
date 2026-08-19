/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// API Service Layer - All backend endpoints

import { httpClient } from "./http-client";
import { API_ENDPOINTS } from "@/config/api-endpoints";
import {
	RequestTransformer,
	CollectionTransformer,
	RunReportTransformer,
	GlobalsTransformer,
	type RawCollection,
	type RawRequest,
} from "./transformers";
import type {
	Collection,
	Request,
	RequestExample,
	Environment,
	GlobalVariables,
	VariableValue,
	Run,
	RunListResponse,
	RunListParams,
	RunReport,
	RunSamplesResponse,
	EngineHealth,
	SanityResult,
	ScriptCompletionsResponse,
	ScriptTypeDefinitionsResponse,
	CreateCollectionRequest,
	UpdateCollectionRequest,
	ListRequestsParams,
	CreateRequestRequest,
	UpdateRequestRequest,
	CreateRequestExampleRequest,
	ReorderRequest,
	ReorderResponse,
	CreateEnvironmentRequest,
	UpdateEnvironmentRequest,
	ComposeRequestRequest,
	ComposedRequest,
	ExecuteRequestRequest,
	ExecuteStreamResponse,
	StartLoadTestRequest,
	StartLoadTestResponse,
	StartScenarioRunRequest,
	GetRunReportResponse,
	StopRunResponse,
	GetHealthResponse,
	GetCookiesResponse,
	ClearCookiesResponse,
	ClientCertificate,
	ClientCertificateInput,
	ConnectionTestResult,
	GetConfigResponse,
	UpdateConfigRequest,
	GlobalsResponse,
	ImportFetchResponse,
	ImportApplyRequest,
	ImportApplyResponse,
	CreateSpecRequest,
	SpecSyncRequest,
	SpecSyncResponse,
	SpecDocument,
	SpecDocumentMeta,
	OAuth2TokenRequest,
	OAuth2TokenResponse,
	OAuth2TokenStatusResponse,
	OAuth2AuthorizeStartRequest,
	OAuth2AuthorizeStartResponse,
	OAuth2AuthorizeStatusResponse,
	Inbox,
	InboxCannedResponse,
	InboxCapturesResponse,
	ListInboxesResponse,
	StartInboxRequest,
	ClearInboxCapturesResponse,
	DeleteInboxResponse,
	MockIssuer,
	ListMockIssuersResponse,
	StartMockIssuerRequest,
	StartMockIssuerResponse,
	UpdateMockIssuerRequest,
	StopMockIssuerResponse,
	MockServer,
	MockServerRoute,
	ListMockServersResponse,
	ListMockServerRoutesResponse,
	StartMockServerRequest,
	StopMockServerResponse,
} from "@/types";
import type { MonitorSeriesResponse, TimeSeriesResponse } from "@/modules/history/types";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import {
	PROXIED_TIMEOUT_GRACE_MS,
	ENGINE_MAX_DEFAULT_TIMEOUT_MS,
	STATS_PAGE_LIMIT,
	RUN_SAMPLES_PAGE_LIMIT,
	RUNS_PAGE_LIMIT,
	INBOX_CAPTURES_PAGE_LIMIT,
} from "@/config/network";

/**
 * Timeout for engine calls that proxy a remote server (/request,
 * /import/fetch). These block for as long as the target takes, bounded by the
 * engine's user-configurable `defaultTimeout` setting - so derive the UI
 * timeout from it instead of the flat default, with enough grace that the
 * engine's own TIMEOUT error (proper error code) arrives before the UI aborts.
 * Falls back to the engine's max when the config cache is cold. If per-request
 * timeout overrides are ever added, this must become max(default, override).
 */
function proxiedRequestTimeoutMs(): number {
	const config = queryClient.getQueryData<GetConfigResponse>(queryKeys.config.all);
	const engineTimeout = Number(config?.entries.find((e) => e.key === "defaultTimeout")?.value);
	const base =
		Number.isFinite(engineTimeout) && engineTimeout > 0
			? engineTimeout
			: ENGINE_MAX_DEFAULT_TIMEOUT_MS;
	return base + PROXIED_TIMEOUT_GRACE_MS;
}

/**
 * Drop `id` from a create payload before it is sent.
 *
 * Since #97 the engine assigns every id and answers a create carrying one with a
 * `400`, so this is the difference between a save working and failing, not
 * cosmetics. The `Create*Request` types already have no `id`, but that is not a
 * guarantee: excess-property checking only fires on object literals, so a call
 * site that spreads a whole record (a duplicate flow, a restored tab, a
 * transformer output) passes one through unnoticed. Stripping it in the one
 * place every create goes through makes the payload correct by construction
 * rather than by review of each new call site.
 */
function withoutId<T extends object>(data: T): Omit<T, "id"> {
	const { id: _engineAssigned, ...rest } = data as T & { id?: unknown };
	return rest;
}

export const apiService = {
	// Health & Configuration
	async getHealth(): Promise<EngineHealth> {
		const response = await httpClient.get<GetHealthResponse>(API_ENDPOINTS.HEALTH);
		return response;
	},

	async getConfig(): Promise<GetConfigResponse> {
		const response = await httpClient.get<GetConfigResponse>(API_ENDPOINTS.CONFIG);
		return response;
	},

	async updateConfig(config: UpdateConfigRequest): Promise<GetConfigResponse> {
		return await httpClient.post<GetConfigResponse>(API_ENDPOINTS.CONFIG, config);
	},

	// Collections
	async listCollections(): Promise<Collection[]> {
		const response = await httpClient.get<RawCollection[]>(API_ENDPOINTS.COLLECTIONS);
		return response.map(CollectionTransformer.toFrontend);
	},

	async createCollection(data: CreateCollectionRequest): Promise<Collection> {
		const response = await httpClient.post<RawCollection>(
			API_ENDPOINTS.COLLECTIONS,
			withoutId(data)
		);
		return CollectionTransformer.toFrontend(response);
	},

	async updateCollection(data: UpdateCollectionRequest): Promise<Collection> {
		// PUT, not POST: since #95 the engine's POST is create-only and answers a
		// known id with 409. The id travels in the path (it is the identity);
		// the rest of the object is a merge-patch, where an omitted field keeps
		// its stored value and an explicit null resets it to the default.
		const { id, ...patch } = data;
		const response = await httpClient.put<RawCollection>(
			API_ENDPOINTS.COLLECTIONS_UPDATE(id),
			patch
		);
		return CollectionTransformer.toFrontend(response);
	},

	async deleteCollection(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.COLLECTION_BY_ID(id));
	},

	// Requests
	async listRequests(params?: ListRequestsParams): Promise<Request[]> {
		const queryParams = params?.collectionId
			? { collectionId: params.collectionId }
			: undefined;
		const response = await httpClient.get<RawRequest[]>(API_ENDPOINTS.REQUESTS, queryParams);
		return response.map(RequestTransformer.toFrontend);
	},

	async getRequest(id: string): Promise<Request> {
		const response = await httpClient.get<RawRequest>(API_ENDPOINTS.REQUEST_BY_ID(id));
		return RequestTransformer.toFrontend(response);
	},

	async createRequest(data: CreateRequestRequest): Promise<Request> {
		const response = await httpClient.post<RawRequest>(API_ENDPOINTS.REQUESTS, withoutId(data));
		return RequestTransformer.toFrontend(response);
	},

	async updateRequest(data: UpdateRequestRequest): Promise<Request> {
		// PUT, not POST - see updateCollection above for why.
		const { id, ...patch } = data;
		const response = await httpClient.put<RawRequest>(API_ENDPOINTS.REQUESTS_UPDATE(id), patch);
		return RequestTransformer.toFrontend(response);
	},

	async deleteRequest(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.REQUEST_BY_ID(id));
	},

	/**
	 * A request's saved example responses, in stored order (issue #481).
	 *
	 * No transformer: unlike a request row, an example carries no timestamp the
	 * app renders and no column that predates a schema change, so there is
	 * nothing to reconcile - the wire shape is the domain shape, minus the
	 * `order` and timestamps `RequestExample` deliberately does not claim.
	 */
	async listRequestExamples(requestId: string): Promise<RequestExample[]> {
		return await httpClient.get<RequestExample[]>(API_ENDPOINTS.REQUEST_EXAMPLES(requestId));
	},

	// Specs (issue #637)

	/**
	 * Store one OpenAPI document and get back its engine id and hash.
	 *
	 * The hash is computed engine-side on the bytes it stored, never here: the
	 * binding it goes into is compared against a hash a *run* was stamped with,
	 * and two implementations of sha256 agreeing is a thing to rely on only when
	 * one of them did both.
	 */
	async createSpec(data: CreateSpecRequest): Promise<SpecDocument> {
		return await httpClient.post<SpecDocument>(API_ENDPOINTS.SPECS, withoutId(data));
	},

	/**
	 * One stored document, `content` included - for the readers that need the
	 * text: export, the sync comparison, and `$ref` resolution. Each of those
	 * runs on a user action, so the transfer is paid when it buys something.
	 *
	 * Describing a document rather than reading it is `getSpecMeta` below.
	 */
	async getSpec(id: string): Promise<SpecDocument> {
		return await httpClient.get<SpecDocument>(API_ENDPOINTS.SPEC_BY_ID(id));
	},

	/**
	 * What a stored document *is*, without the document (issue #712).
	 *
	 * The Spec tab's card wants `sourceUrl` and `fetchedAt`, which live on the
	 * document rather than on the collection's binding - and pulling the whole
	 * document for them cost 12 MB on a first open of a Stripe-sized spec. The
	 * fields here are the document's own values, so a card painted from this
	 * read says exactly what one painted from `getSpec` would.
	 */
	async getSpecMeta(id: string): Promise<SpecDocumentMeta> {
		return await httpClient.get<SpecDocumentMeta>(API_ENDPOINTS.SPEC_META(id));
	},

	/**
	 * Apply a re-fetched document to the collection bound to it (issue #655).
	 *
	 * One call because it has to be one transaction: the document, the binding
	 * that moves to it and every row the diff selected land together or not at
	 * all. Expressed as N writes it could stop halfway and leave a collection
	 * bound to a document its requests do not reflect.
	 */
	async syncSpec(payload: SpecSyncRequest): Promise<SpecSyncResponse> {
		return await httpClient.post<SpecSyncResponse>(API_ENDPOINTS.SPEC_SYNC, payload);
	},

	/**
	 * Keep a response as one of the request's examples (issue #588).
	 *
	 * POST, and create-only like every other resource: the engine assigns the id
	 * (#97), and `withoutId` strips one a spread carried in for the same reason
	 * `createRequest` does. No `order` is sent - the engine appends, which is
	 * what keeps a running mock's first-example answer unchanged.
	 */
	async createRequestExample(
		requestId: string,
		data: CreateRequestExampleRequest
	): Promise<RequestExample> {
		return await httpClient.post<RequestExample>(
			API_ENDPOINTS.REQUEST_EXAMPLES(requestId),
			withoutId(data)
		);
	},

	/**
	 * Remove one saved example.
	 *
	 * The request id is in the path rather than inferred: the engine checks the
	 * owner before the example, so an example reached through the wrong request
	 * is a 404 rather than a cross-request delete.
	 */
	async deleteRequestExample(requestId: string, exampleId: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.REQUEST_EXAMPLE_BY_ID(requestId, exampleId));
	},

	/**
	 * Reposition collections and requests in one atomic batch.
	 *
	 * The response is the rows as written, not an acknowledgement: the caller
	 * has already drawn the drop optimistically and settles its caches on these
	 * rows, so a normalization the engine performed is visible immediately
	 * rather than only after the refetch lands.
	 */
	async reorder(data: ReorderRequest): Promise<ReorderResponse> {
		const response = await httpClient.post<{
			collections: RawCollection[];
			requests: RawRequest[];
		}>(API_ENDPOINTS.REORDER, data);
		return {
			collections: response.collections.map(CollectionTransformer.toFrontend),
			requests: response.requests.map(RequestTransformer.toFrontend),
		};
	},

	// Environments
	async listEnvironments(): Promise<Environment[]> {
		// Backend returns flat array directly
		return await httpClient.get<Environment[]>(API_ENDPOINTS.ENVIRONMENTS);
	},

	async getEnvironment(id: string): Promise<Environment> {
		return await httpClient.get<Environment>(API_ENDPOINTS.ENVIRONMENT_BY_ID(id));
	},

	async createEnvironment(data: CreateEnvironmentRequest): Promise<Environment> {
		return await httpClient.post<Environment>(API_ENDPOINTS.ENVIRONMENTS, withoutId(data));
	},

	async updateEnvironment(data: UpdateEnvironmentRequest): Promise<Environment> {
		// PUT, not POST - see updateCollection above for why.
		const { id, ...patch } = data;
		return await httpClient.put<Environment>(API_ENDPOINTS.ENVIRONMENTS_UPDATE(id), patch);
	},

	async deleteEnvironment(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.ENVIRONMENT_BY_ID(id));
	},

	// Global Variables
	async getGlobals(): Promise<GlobalVariables> {
		const response = await httpClient.get<GlobalsResponse>(API_ENDPOINTS.GLOBALS);
		return GlobalsTransformer.toFrontend(response);
	},

	async updateGlobals(variables: Record<string, VariableValue>): Promise<GlobalVariables> {
		const response = await httpClient.post<GlobalsResponse>(API_ENDPOINTS.GLOBALS, {
			variables,
		});
		return GlobalsTransformer.toFrontend(response);
	},

	// Cookie jar (issue #301)
	async getCookies(): Promise<GetCookiesResponse> {
		return await httpClient.get<GetCookiesResponse>(API_ENDPOINTS.COOKIES);
	},

	/**
	 * Clear one jar, or every jar.
	 *
	 * The parameter distinguishes three cases the way the engine does: omitted
	 * clears everything, `null` clears the jar used when no environment is
	 * selected, and an id clears that environment's. Passing `null` and passing
	 * nothing are therefore *not* the same call: one reaches the engine with
	 * the parameter present and empty, the other with no parameter at all.
	 */
	async clearCookies(scope?: { environmentId: string | null }): Promise<ClearCookiesResponse> {
		return await httpClient.delete<ClearCookiesResponse>(
			API_ENDPOINTS.COOKIES,
			scope === undefined ? undefined : { environmentId: scope.environmentId ?? "" }
		);
	},

	/**
	 * Test how a URL is reached under the current transport policy (issue #708).
	 *
	 * A *failed* connection still resolves: the engine answers 200 with the
	 * outcome, because the test succeeded in answering. Only a malformed
	 * request throws. No response body comes back - by design, and asserted
	 * engine-side - so this can never become a second import proxy.
	 */
	async testConnection(url: string): Promise<ConnectionTestResult> {
		return await httpClient.post<ConnectionTestResult>(API_ENDPOINTS.DIAGNOSTICS_CONNECTION, {
			url,
		});
	},

	// Client-certificate registry (issue #707)
	async getClientCertificates(): Promise<ClientCertificate[]> {
		return await httpClient.get<ClientCertificate[]>(API_ENDPOINTS.CLIENT_CERTIFICATES);
	},

	async createClientCertificate(input: ClientCertificateInput): Promise<ClientCertificate> {
		return await httpClient.post<ClientCertificate>(API_ENDPOINTS.CLIENT_CERTIFICATES, input);
	},

	/**
	 * Merge-patch, like every other update here: an absent field keeps its
	 * value, `port: null` widens the entry to every port and `passphrase: null`
	 * clears a stored one. `id` is stripped because the engine owns it (#97).
	 */
	async updateClientCertificate(
		id: string,
		patch: Partial<ClientCertificateInput>
	): Promise<ClientCertificate> {
		return await httpClient.put<ClientCertificate>(
			API_ENDPOINTS.CLIENT_CERTIFICATE_BY_ID(id),
			patch
		);
	},

	async deleteClientCertificate(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.CLIENT_CERTIFICATE_BY_ID(id));
	},

	// Webhook inbox (issue #480)
	async listInboxes(): Promise<Inbox[]> {
		const response = await httpClient.get<ListInboxesResponse>(API_ENDPOINTS.INBOX);
		return response.data;
	},

	async startInbox(request: StartInboxRequest = {}): Promise<Inbox> {
		return await httpClient.post<Inbox>(API_ENDPOINTS.INBOX_START, request);
	},

	async stopInbox(inboxId: string): Promise<Inbox> {
		return await httpClient.post<Inbox>(API_ENDPOINTS.INBOX_STOP(inboxId), {});
	},

	/**
	 * Delete the inbox and the captures it is holding (issue #553).
	 *
	 * Stronger than `stopInbox`, which frees the listener and leaves the record
	 * - and its captures - readable for the life of the engine process. A
	 * running inbox is stopped by the engine on the way, so this is one call
	 * whatever state the inbox is in.
	 */
	async deleteInbox(inboxId: string): Promise<DeleteInboxResponse> {
		return await httpClient.delete<DeleteInboxResponse>(API_ENDPOINTS.INBOX_BY_ID(inboxId));
	},

	/**
	 * Update the canned response, live. Merge-patch: an omitted field keeps the
	 * value the inbox is serving, so changing the status does not silently drop
	 * the headers a caller configured.
	 */
	async updateInboxResponse(
		inboxId: string,
		response: Partial<InboxCannedResponse>
	): Promise<Inbox> {
		return await httpClient.put<Inbox>(API_ENDPOINTS.INBOX_BY_ID(inboxId), response);
	},

	async listInboxCaptures(
		inboxId: string,
		limit = INBOX_CAPTURES_PAGE_LIMIT,
		offset = 0
	): Promise<InboxCapturesResponse> {
		return await httpClient.get<InboxCapturesResponse>(
			API_ENDPOINTS.INBOX_CAPTURES(inboxId, limit, offset)
		);
	},

	async clearInboxCaptures(inboxId: string): Promise<ClearInboxCapturesResponse> {
		return await httpClient.delete<ClearInboxCapturesResponse>(
			API_ENDPOINTS.INBOX_CAPTURES_CLEAR(inboxId)
		);
	},

	// OAuth 2.0 mock issuer (issue #479)
	async listMockIssuers(): Promise<MockIssuer[]> {
		const response = await httpClient.get<ListMockIssuersResponse>(API_ENDPOINTS.MOCK_ISSUER);
		return response.issuers;
	},

	async startMockIssuer(request: StartMockIssuerRequest = {}): Promise<StartMockIssuerResponse> {
		return await httpClient.post<StartMockIssuerResponse>(
			API_ENDPOINTS.MOCK_ISSUER_START,
			request
		);
	},

	/**
	 * Change what a *running* issuer does. Only the three mutable settings are
	 * accepted - a port, client list or claim set cannot move under a bound
	 * listener, and the engine refuses one rather than half-applying it.
	 */
	async updateMockIssuer(issuerId: string, update: UpdateMockIssuerRequest): Promise<MockIssuer> {
		return await httpClient.put<MockIssuer>(API_ENDPOINTS.MOCK_ISSUER_BY_ID(issuerId), update);
	},

	async stopMockIssuer(issuerId: string): Promise<StopMockIssuerResponse> {
		return await httpClient.post<StopMockIssuerResponse>(
			API_ENDPOINTS.MOCK_ISSUER_STOP(issuerId),
			{}
		);
	},

	// Collection mock server (issue #481 phase 2)
	async listMockServers(): Promise<MockServer[]> {
		const response = await httpClient.get<ListMockServersResponse>(API_ENDPOINTS.MOCK_SERVER);
		return response.data;
	},

	async startMockServer(request: StartMockServerRequest): Promise<MockServer> {
		return await httpClient.post<MockServer>(API_ENDPOINTS.MOCK_SERVER_START, request);
	},

	async stopMockServer(mockId: string): Promise<StopMockServerResponse> {
		return await httpClient.post<StopMockServerResponse>(
			API_ENDPOINTS.MOCK_SERVER_STOP(mockId),
			{}
		);
	},

	/**
	 * The table a mock is serving - method, path template, and whether the
	 * request behind it has an example. This is how "the mock answers 404" gets
	 * diagnosed without sending a request per guess.
	 */
	async listMockServerRoutes(mockId: string): Promise<MockServerRoute[]> {
		const response = await httpClient.get<ListMockServerRoutesResponse>(
			API_ENDPOINTS.MOCK_SERVER_ROUTES(mockId)
		);
		return response.data;
	},

	// Execution
	/**
	 * Compose a request engine-side (`POST /compose`): `{{variables}}` and
	 * `inherit` auth resolved, execute-ready payload back. Pure - nothing is
	 * sent - and `/execute` / `/runs` never interpolate, so composing here and
	 * executing the result resolves everything exactly once (issue #226).
	 */
	async composeRequest(data: ComposeRequestRequest): Promise<ComposedRequest> {
		return await httpClient.post<ComposedRequest>(API_ENDPOINTS.COMPOSE_REQUEST, data);
	},

	/**
	 * `allowScriptRequests` opts this execution's scripts into `pm.sendRequest`
	 * (issue #302). The engine denies it unless asked, because Vayu's MCP target
	 * allowlist is checked in the MCP server *before* it calls the engine - a
	 * request issued from inside a script never passes that gate. The renderer
	 * is the surface whose scripts the user wrote, so it asks; the MCP server
	 * never does, and an agent cannot smuggle the field in because every MCP
	 * tool builds its request from named arguments.
	 *
	 * Set here rather than at each call site, so a new caller cannot forget it
	 * and quietly lose the feature - the same single-choke-point reason
	 * `httpVersion` and the redirect policy are sent on every execute rather
	 * than elided when they match a default.
	 */
	async executeRequest(data: ExecuteRequestRequest): Promise<SanityResult> {
		return await httpClient.post<SanityResult>(
			API_ENDPOINTS.EXECUTE_REQUEST,
			{ ...data, allowScriptRequests: true },
			{ timeout: proxiedRequestTimeoutMs() }
		);
	},

	/**
	 * The streaming half of the same endpoint (issue #574): `stream: true` makes
	 * `POST /execute` answer `202 {runId, eventsUrl}` at once instead of the
	 * exchange, so this returns a different type rather than a `SanityResult`
	 * with empty fields - the two answers are different shapes and a caller has
	 * to know which it is holding.
	 *
	 * No `proxiedRequestTimeoutMs()`: this call returns as soon as the run row
	 * exists, and the stream it started is bounded by the engine's own caps
	 * (`maxStreamDurationMs`, `maxStreamEvents`, the idle timeout), not by a
	 * client deadline.
	 *
	 * `allowScriptRequests` is sent here for the same reason `executeRequest`
	 * sends it, and it is the same reason both times: the asker is a user at
	 * the request editor pressing Send, and `stream` describes the shape of the
	 * response, not what that user's scripts may do. The engine reads the flag
	 * before it branches on `stream` (`execution.cpp`), so it governs a
	 * streaming send's pre- and post-request scripts exactly as it governs a
	 * buffered one's (issue #653).
	 */
	async executeStreamRequest(data: ExecuteRequestRequest): Promise<ExecuteStreamResponse> {
		const answer = await httpClient.post<ExecuteStreamResponse>(API_ENDPOINTS.EXECUTE_REQUEST, {
			...data,
			stream: true,
			allowScriptRequests: true,
		});
		// Loud rather than a stream that silently never opens: without both
		// fields there is no run to stop and no URL to tail, and the response
		// pane would sit on "streaming" forever.
		if (!answer?.runId || !answer?.eventsUrl) {
			throw new Error("The engine accepted the stream but named no run to follow");
		}
		return answer;
	},

	/** A run's `tests` script is the same script Send runs - see executeRequest. */

	async startLoadTest(data: StartLoadTestRequest): Promise<StartLoadTestResponse> {
		return await httpClient.post<StartLoadTestResponse>(API_ENDPOINTS.START_LOAD_TEST, {
			...data,
			allowScriptRequests: true,
		});
	},

	/**
	 * Start a collection run. The same `POST /runs` endpoint and the same
	 * `202 {runId}` answer as a load test - the payload's `scenario` block is
	 * what selects the sequential executor.
	 *
	 * `allowScriptRequests` for the same reason a load test sends it: every step
	 * runs the pre-request and test scripts a Send of that request would run.
	 */
	async startScenarioRun(data: StartScenarioRunRequest): Promise<StartLoadTestResponse> {
		return await httpClient.post<StartLoadTestResponse>(API_ENDPOINTS.START_LOAD_TEST, {
			...data,
			allowScriptRequests: true,
		});
	},

	// Run Management
	/**
	 * List runs, newest first, as a `{data, pagination}` envelope. Passing
	 * pagination/filter params opts into the envelope; the history sidebar polls
	 * the first page and pages older runs in on demand.
	 */
	async listRuns(params: RunListParams = {}): Promise<RunListResponse> {
		const {
			limit = RUNS_PAGE_LIMIT,
			offset = 0,
			type,
			status,
			requestId,
			collectionId,
			q,
			baseline,
		} = params;
		return await httpClient.get<RunListResponse>(
			API_ENDPOINTS.RUNS_LIST({
				limit,
				offset,
				type,
				status,
				requestId,
				collectionId,
				q,
				baseline,
			})
		);
	},

	/**
	 * Fetch every run matching @p params by paging to exhaustion. For callers
	 * that genuinely need the whole set (clearing all history, counting) rather
	 * than a polled page. Rows still carry the compact `summary`, so this stays
	 * cheap even over a large history.
	 */
	async listAllRuns(params: Omit<RunListParams, "limit" | "offset"> = {}): Promise<Run[]> {
		const limit = 500; // Engine's max page size.
		const all: Run[] = [];
		let offset = 0;
		// Bounded by pagination.hasMore; the engine caps limit at 500.
		for (;;) {
			const page = await this.listRuns({ ...params, limit, offset });
			all.push(...page.data);
			if (!page.pagination.hasMore) break;
			offset += page.pagination.limit;
		}
		return all;
	},

	async getRun(id: string): Promise<Run> {
		// Backend returns run object directly
		return await httpClient.get<Run>(API_ENDPOINTS.RUN_BY_ID(id));
	},

	async getRunReport(id: string): Promise<RunReport> {
		const response = await httpClient.get<GetRunReportResponse>(API_ENDPOINTS.RUN_REPORT(id));
		return RunReportTransformer.toFrontend(response);
	},

	/**
	 * The response headers and body captured for a run's retained samples -
	 * every error, the slow outliers, and the first few of each status code.
	 *
	 * Its own request rather than fields on the report: the report path loads
	 * and parses every result row for a run on each fetch, and the dashboard
	 * polls it. Join a page's `resultId` against `report.results[].id`.
	 */
	async getRunSamples(
		id: string,
		options: { limit?: number; offset?: number } = {}
	): Promise<RunSamplesResponse> {
		const { limit = RUN_SAMPLES_PAGE_LIMIT, offset = 0 } = options;
		return await httpClient.get<RunSamplesResponse>(
			API_ENDPOINTS.RUN_SAMPLES(id, limit, offset)
		);
	},

	async stopRun(id: string): Promise<StopRunResponse> {
		return await httpClient.post<StopRunResponse>(API_ENDPOINTS.RUN_STOP(id));
	},

	async deleteRun(id: string): Promise<void> {
		await httpClient.delete(API_ENDPOINTS.RUN_BY_ID(id));
	},

	/**
	 * Pin or unpin a run as the baseline for its request. Answers the updated
	 * list row, so a caller can patch its cached row instead of re-listing.
	 */
	async setRunBaseline(id: string, baseline: boolean): Promise<Run> {
		return await httpClient.put<Run>(API_ENDPOINTS.RUN_BASELINE(id), { baseline });
	},

	/**
	 * Get time-series metrics for a run (paginated)
	 * Used for rendering historical charts
	 */
	async getRunTimeSeries(
		id: string,
		options: { limit?: number; offset?: number } = {}
	): Promise<TimeSeriesResponse> {
		const { limit = STATS_PAGE_LIMIT, offset = 0 } = options;
		return await httpClient.get<TimeSeriesResponse>(
			API_ENDPOINTS.STATS_TIME_SERIES(id, limit, offset)
		);
	},

	async getRunMonitorSeries(
		id: string,
		options: { limit?: number; offset?: number } = {}
	): Promise<MonitorSeriesResponse> {
		const { limit = STATS_PAGE_LIMIT, offset = 0 } = options;
		return await httpClient.get<MonitorSeriesResponse>(
			API_ENDPOINTS.RUN_MONITOR(id, limit, offset)
		);
	},

	// Scripting
	async getScriptCompletions(): Promise<ScriptCompletionsResponse> {
		return await httpClient.get<ScriptCompletionsResponse>(API_ENDPOINTS.SCRIPT_COMPLETIONS);
	},

	async getScriptTypeDefinitions(): Promise<ScriptTypeDefinitionsResponse> {
		return await httpClient.get<ScriptTypeDefinitionsResponse>(API_ENDPOINTS.SCRIPT_TYPES);
	},

	// Import
	/**
	 * Fetch a URL through the engine, past the renderer's CORS.
	 *
	 * @param maxBytes the largest response this fetch may read (issue #784).
	 * The route is one proxy for every import format, so the engine has no
	 * format to derive a bound from: a caller that knows it is fetching an
	 * OpenAPI document passes the live `maxSpecDocumentBytes`
	 * ({@link useSpecDocumentLimit}), and a format-agnostic caller passes
	 * nothing and gets the engine's transport ceiling - a number no import may
	 * exceed, deliberately not restated here so the two cannot drift. Over the
	 * bound is a `413` whose message names it.
	 */
	async importFetch(url: string, maxBytes?: number): Promise<ImportFetchResponse> {
		return await httpClient.post<ImportFetchResponse>(
			API_ENDPOINTS.IMPORT_FETCH,
			maxBytes === undefined ? { url } : { url, maxBytes },
			{ timeout: proxiedRequestTimeoutMs() }
		);
	},

	/**
	 * Persist a whole parsed import in one call. All-or-nothing: a rejected
	 * payload wrote nothing, so there is no partial tree to clean up. The engine
	 * owns every id here and returns the temp-id -> real-id map.
	 */
	async applyImport(payload: ImportApplyRequest): Promise<ImportApplyResponse> {
		return await httpClient.post<ImportApplyResponse>(API_ENDPOINTS.IMPORT_APPLY, payload);
	},

	// OAuth 2.0 - the engine proxies the token endpoint, so use the longer
	// proxied timeout (as with executeRequest / importFetch).
	async fetchOAuth2Token(data: OAuth2TokenRequest): Promise<OAuth2TokenResponse> {
		return await httpClient.post<OAuth2TokenResponse>(API_ENDPOINTS.OAUTH2_TOKEN, data, {
			timeout: proxiedRequestTimeoutMs(),
		});
	},

	async getOAuth2TokenStatus(cacheKey: string): Promise<OAuth2TokenStatusResponse> {
		return await httpClient.get<OAuth2TokenStatusResponse>(API_ENDPOINTS.OAUTH2_TOKEN, {
			key: cacheKey,
		});
	},

	async clearOAuth2Token(cacheKey: string): Promise<void> {
		await httpClient.delete<{ deleted: boolean }>(API_ENDPOINTS.OAUTH2_TOKEN, {
			key: cacheKey,
		});
	},

	async startOAuth2Authorize(
		data: OAuth2AuthorizeStartRequest
	): Promise<OAuth2AuthorizeStartResponse> {
		return await httpClient.post<OAuth2AuthorizeStartResponse>(
			API_ENDPOINTS.OAUTH2_AUTHORIZE_START,
			data
		);
	},

	async completeOAuth2Authorize(
		attemptId: string,
		callbackUrl: string
	): Promise<OAuth2AuthorizeStatusResponse> {
		return await httpClient.post<OAuth2AuthorizeStatusResponse>(
			API_ENDPOINTS.OAUTH2_AUTHORIZE_COMPLETE,
			{ attemptId, callbackUrl }
		);
	},

	async getOAuth2AuthorizeStatus(attemptId: string): Promise<OAuth2AuthorizeStatusResponse> {
		return await httpClient.get<OAuth2AuthorizeStatusResponse>(
			API_ENDPOINTS.OAUTH2_AUTHORIZE_STATUS(attemptId)
		);
	},
};
