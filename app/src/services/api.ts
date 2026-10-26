/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// API Service Layer - All backend endpoints

import { httpClient, ApiError, EngineUnreachableError } from "./http-client";
import { API_ENDPOINTS } from "@/config/api-endpoints";
import { IMPORT_FETCH_EVENTS, IMPORT_FETCH_STALL_TIMEOUT_MS } from "@/constants/import";
import type { AllowFolderReply } from "@/types/electron";
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
	RequestSummary,
	RequestExample,
	ListTrashResponse,
	RestoreTrashResponse,
	PurgeTrashResponse,
	Environment,
	GlobalVariables,
	VariableValue,
	Run,
	RunOrigin,
	RunListResponse,
	RunListParams,
	RunReport,
	RunSamplesResponse,
	EngineHealth,
	SanityResult,
	ScriptCompletionsResponse,
	ScriptTypeDefinitionsResponse,
	ElementKindSchema,
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
	ClearRunsResponse,
	GetHealthResponse,
	GetCookiesResponse,
	ClearCookiesResponse,
	ClientCertificate,
	ClientCertificateInput,
	FileRoot,
	ConnectionTestResult,
	WorkspaceBackupResult,
	GetConfigResponse,
	RequestDefaults,
	RequestDefaultsScope,
	UpdateConfigRequest,
	GlobalsResponse,
	ImportFetchOptions,
	ImportFetchProgress,
	ImportFetchResponse,
	ImportApplyRequest,
	ImportParseRequest,
	ImportApplyResponse,
	CreateSpecRequest,
	SpecBindRequest,
	SpecBindResponse,
	SpecExportRequest,
	SpecExportResponse,
	PostmanExportRequest,
	PostmanExportResponse,
	PostmanEnvironmentExportRequest,
	PostmanEnvironmentExportResponse,
	RunReportExportRequest,
	RunReportExportResponse,
	SpecDescribeRequest,
	SpecDescribeResponse,
	SpecDiffRequest,
	SpecDiffResponse,
	SpecMatchRequest,
	SpecMatchResponse,
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
	MockActivityEntry,
	ListMockServerActivityResponse,
	StartMockServerRequest,
	StopMockServerResponse,
} from "@/types";
import type { ImportResult } from "@/services/importers/types";
import type { MonitorSeriesResponse, TimeSeriesResponse } from "@/modules/history/types";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import { executeBudgetMs } from "@/lib/execute-budget";
import {
	PROXIED_TIMEOUT_GRACE_MS,
	STATS_PAGE_LIMIT,
	RUN_SAMPLES_PAGE_LIMIT,
	RUNS_PAGE_LIMIT,
	INBOX_CAPTURES_PAGE_LIMIT,
} from "@/config/network";

/** Every run this renderer starts says so; see `executeRequest`. */
const APP_ORIGIN: RunOrigin = { kind: "app" };

/**
 * The client's budget for `POST /import/fetch`: the engine's stall bound plus
 * the grace, not the `defaultTimeout` setting, because the engine does not
 * bound this route by the setting. A total (the buffered form) or an idle gap
 * (the streamed form) of this length outlasts the longest silence the engine
 * allows, so its own error arrives first. A steady download slower than this
 * still aborts the buffered form client-side while the engine keeps reading.
 */
const IMPORT_FETCH_BUDGET_MS = IMPORT_FETCH_STALL_TIMEOUT_MS + PROXIED_TIMEOUT_GRACE_MS;

/** A config entry's value as a number, `0` when the cache is cold or the value unreadable. */
function configuredMs(key: string): number {
	const config = queryClient.getQueryData<GetConfigResponse>(queryKeys.config.all);
	const value = Number(config?.entries.find((e) => e.key === key)?.value);
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The abort budget for an engine call that proxies a remote server: the engine's
 * own bound plus enough grace that its TIMEOUT error (with a proper code and a
 * recorded run) arrives before the UI aborts. Falls back to the engine's maxima
 * when the config cache is cold.
 *
 * With no payload this is the `defaultTimeout` setting plus the grace, which is
 * all a bare transfer needs (`/oauth2/token`). Given the `POST /execute` payload
 * it is a worst case for that request - an OAuth 2.0 token fetch and every
 * script add their own bounds ({@link executeBudgetMs}) - because the call runs
 * them in sequence. `/import/fetch` is not budgeted here: the engine bounds it
 * by a fixed stall, not the setting ({@link IMPORT_FETCH_BUDGET_MS}).
 */
function proxiedRequestTimeoutMs(payload?: unknown): number {
	return executeBudgetMs(payload, {
		defaultTimeoutMs: configuredMs("defaultTimeout"),
		scriptTimeoutMs: configuredMs("scriptTimeout"),
	});
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

/** The query string of a `GET /requests`, `undefined` when it asks for nothing. */
function requestListQuery(params: ListRequestsParams): Record<string, string> | undefined {
	const query: Record<string, string> = {};
	if (params.collectionId) query.collectionId = params.collectionId;
	if (params.fields) query.fields = params.fields;
	return Object.keys(query).length > 0 ? query : undefined;
}

/**
 * The Electron bridge's two allowed-folder writes. Absent outside Electron,
 * where nothing holds the secret the engine requires for either.
 */
function fileTrustBridge(): Pick<
	NonNullable<Window["electronAPI"]>,
	"allowFolder" | "removeAllowedFolder"
> {
	const bridge = typeof window === "undefined" ? undefined : window.electronAPI;
	if (!bridge) throw new Error("Allowed folders change only in the Vayu app.");
	return bridge;
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

	async getRequestDefaults(scope?: RequestDefaultsScope): Promise<RequestDefaults> {
		const params = scope ? { scope } : undefined;
		return await httpClient.get<RequestDefaults>(API_ENDPOINTS.REQUEST_DEFAULTS, params);
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
	async listRequests(params: Omit<ListRequestsParams, "fields"> = {}): Promise<Request[]> {
		const response = await httpClient.get<RawRequest[]>(
			API_ENDPOINTS.REQUESTS,
			requestListQuery(params)
		);
		return response.map(RequestTransformer.toFrontend);
	},

	/**
	 * The same rows as `listRequests`, in the same order, cut to the tree's
	 * columns (#2546): no body, header set, auth or element list is read or sent.
	 */
	async listRequestSummaries(
		params: Omit<ListRequestsParams, "fields"> = {}
	): Promise<RequestSummary[]> {
		const response = await httpClient.get<RawRequest[]>(
			API_ENDPOINTS.REQUESTS,
			requestListQuery({ ...params, fields: "summary" })
		);
		return response.map(RequestTransformer.toSummary);
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

	// Trash (issue #988). No transformer on any of the three: a trash entry is
	// the engine's own summary of a deleted row - a name, a stamp and two counts
	// - rather than a stored record the app reshapes, so the wire shape is the
	// only shape.

	async listTrash(): Promise<ListTrashResponse> {
		return await httpClient.get<ListTrashResponse>(API_ENDPOINTS.TRASH);
	},

	/**
	 * Put one deleted root back, with everything its delete took along.
	 *
	 * Rejects with a 409 for a request whose collection is itself in the trash -
	 * the engine names that collection in the message, so callers surface
	 * `ApiError.message` rather than inventing wording for it.
	 */
	async restoreTrashEntry(id: string): Promise<RestoreTrashResponse> {
		return await httpClient.post<RestoreTrashResponse>(API_ENDPOINTS.TRASH_RESTORE(id));
	},

	/** Destroy one deleted root for good - the cascade the soft delete deferred. */
	async purgeTrashEntry(id: string): Promise<PurgeTrashResponse> {
		return await httpClient.delete<PurgeTrashResponse>(API_ENDPOINTS.TRASH_BY_ID(id));
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
	 * What a picked document is - its dialect, its title and the operations it
	 * declares - without storing it (issue #869).
	 *
	 * Reads only, and the last read of a document this app used to make itself:
	 * the Spec tab parsed a picked file to paint its card and to hand the
	 * identities to `matchSpecOperations` below, while the bind derived the same
	 * identities from the same bytes engine-side - so a document the two read
	 * differently previewed one pairing and committed another.
	 */
	async describeSpec(payload: SpecDescribeRequest): Promise<SpecDescribeResponse> {
		return await httpClient.post<SpecDescribeResponse>(API_ENDPOINTS.SPEC_DESCRIBE, payload);
	},

	/**
	 * Which request of a collection is which operation of a document (issue
	 * #761).
	 *
	 * Reads only: the tab asks this about a document the user has not decided to
	 * bind, so nothing is stored, stamped or created. The matching rule itself is
	 * the engine's (`core/operation_match.hpp`) - it moved there so that
	 * everything which is not the Spec tab, an agent over MCP first among them,
	 * can bind a collection the same way rather than through a second copy of it.
	 */
	async matchSpecOperations(payload: SpecMatchRequest): Promise<SpecMatchResponse> {
		return await httpClient.post<SpecMatchResponse>(API_ENDPOINTS.SPEC_MATCH, payload);
	},

	/**
	 * What a re-fetched document would change about a bound collection
	 * (issue #854).
	 *
	 * Reads only, and the whole comparison: which request is which operation
	 * after a rename, which fields the document moved, and which of those the
	 * user had edited themselves. It moved engine-side because the Sync section
	 * was the last part of this feature only the Spec tab could reach - and
	 * because "what would an import of this document build" now has one answer
	 * (`core::spec_request_drafts_of`) rather than one here and one there.
	 */
	async diffSpec(payload: SpecDiffRequest): Promise<SpecDiffResponse> {
		return await httpClient.post<SpecDiffResponse>(API_ENDPOINTS.SPEC_DIFF, payload);
	},

	/**
	 * Bind a collection to a document (issue #862).
	 *
	 * One call for what used to be three - store the document, move the
	 * binding, stamp the requests - because the three are one state: a bind that
	 * stopped after the second leaves a collection measured against a contract
	 * its requests do not name. The engine does the pairing itself, from the
	 * bytes it stores, so nothing here decides which request is which operation.
	 */
	async bindSpec(payload: SpecBindRequest): Promise<SpecBindResponse> {
		return await httpClient.post<SpecBindResponse>(API_ENDPOINTS.SPEC_BIND, payload);
	},

	/**
	 * A collection back out as an OpenAPI document (issue #855).
	 *
	 * The assembly is the engine's: it reads the subtree, every request's stored
	 * examples and the bound document, patches that document (or writes a
	 * skeleton when the collection binds none) and answers with the finished
	 * text. It moved there with the rest of #761's phase B so that an agent can
	 * export the same way the dialog does - and because the document being
	 * patched is the engine's own stored bytes, which a second reader here could
	 * only disagree with.
	 */
	async exportSpec(payload: SpecExportRequest): Promise<SpecExportResponse> {
		return await httpClient.post<SpecExportResponse>(API_ENDPOINTS.SPEC_EXPORT, payload);
	},

	/**
	 * A collection as a Postman Collection v2.1 document.
	 *
	 * Assembled engine-side for the reason `exportSpec` is: an agent over MCP
	 * gets the same document the dialog downloads. Credentials are written empty
	 * unless `includeSecrets` is set.
	 */
	async exportPostman(payload: PostmanExportRequest): Promise<PostmanExportResponse> {
		return await httpClient.post<PostmanExportResponse>(API_ENDPOINTS.POSTMAN_EXPORT, payload);
	},

	/**
	 * An environment as a Postman environment document (issue #2253). Secret
	 * values are written empty unless `includeSecrets` is set.
	 */
	async exportPostmanEnvironment(
		payload: PostmanEnvironmentExportRequest
	): Promise<PostmanEnvironmentExportResponse> {
		return await httpClient.post<PostmanEnvironmentExportResponse>(
			API_ENDPOINTS.POSTMAN_ENVIRONMENT_EXPORT,
			payload
		);
	},

	/**
	 * A finished load run as a document to share (issue #2127), built engine-side
	 * so an agent over MCP gets the file the app downloads. Nothing that could
	 * carry a credential or a payload is in it; `notes.urlCredentialsOmitted`
	 * counts what the URL lost.
	 */
	async exportRunReport(payload: RunReportExportRequest): Promise<RunReportExportResponse> {
		return await httpClient.post<RunReportExportResponse>(
			API_ENDPOINTS.RUN_REPORT_EXPORT,
			payload
		);
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

	/**
	 * Take one workspace snapshot (issue #987).
	 *
	 * Rejects on 409 - another backup is already running - which is a state the
	 * caller shows rather than a failure: the file the user asked for is still
	 * being written by their earlier request.
	 */
	async backupWorkspace(): Promise<WorkspaceBackupResult> {
		return await httpClient.post<WorkspaceBackupResult>(API_ENDPOINTS.WORKSPACE_BACKUP, {});
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

	// Allowed folders for request-body files (Settings > Files). The list is a
	// plain read; both writes need the grant secret only the main process holds
	// (#2356), so they cross the Electron bridge instead of reaching the engine.
	async getFileRoots(): Promise<FileRoot[]> {
		return await httpClient.get<FileRoot[]>(API_ENDPOINTS.FILE_ROOTS);
	},

	/**
	 * Open the folder picker and allow what the user chooses; the main process
	 * makes the write. Resolves with the engine's answer rather than rejecting
	 * on a refusal, so a caller can tell cancelled, allowed, already allowed (a
	 * `refused` 409) and refused apart and still name the folder chosen.
	 */
	async allowChosenFolder(): Promise<AllowFolderReply> {
		return await fileTrustBridge().allowFolder("allow-folder");
	},

	/** Rejects with the engine's refusal as an `ApiError`, or `EngineUnreachableError`. */
	async deleteFileRoot(id: string): Promise<void> {
		const reply = await fileTrustBridge().removeAllowedFolder(id);
		if (reply.outcome === "refused") {
			throw new ApiError(reply.status, reply.code, reply.message);
		}
		if (reply.outcome === "unreachable") throw new EngineUnreachableError(reply.message);
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

	/** What a running mock has served, newest first. */
	async listMockServerActivity(mockId: string, limit = 50): Promise<MockActivityEntry[]> {
		const response = await httpClient.get<ListMockServerActivityResponse>(
			`${API_ENDPOINTS.MOCK_SERVER_ACTIVITY(mockId)}?limit=${limit}`
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
	 *
	 * `origin` is stamped at the same choke point, on all four run-starting
	 * calls below, and for the same reason: an unstamped run reads as `other`
	 * in History, indistinguishable from a script's. It is set after the spread
	 * so a payload cannot claim a different one (issue #1817).
	 *
	 * `includeParsedBody: false` is stamped here too, and also after the spread:
	 * the pane is built from `bodyRaw`, so the engine's parsed copy of a JSON
	 * body would only be held on its heap and shipped over loopback for nothing
	 * (issue #2544). The MCP server does not send it - its tool result exposes
	 * the parsed `body`.
	 */
	async executeRequest(data: ExecuteRequestRequest): Promise<SanityResult> {
		return await httpClient.post<SanityResult>(
			API_ENDPOINTS.EXECUTE_REQUEST,
			{ ...data, allowScriptRequests: true, origin: APP_ORIGIN, includeParsedBody: false },
			{ timeout: proxiedRequestTimeoutMs(data) }
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
			origin: APP_ORIGIN,
		});
		// Loud rather than a stream that silently never opens: without both
		// fields there is no run to stop and no URL to tail, and the response
		// pane would sit on "streaming" forever.
		if (!answer?.runId || !answer?.eventsUrl) {
			throw new Error("Vayu's engine accepted the stream but named no run to follow");
		}
		return answer;
	},

	/**
	 * A single-target run's `requestElements` are the same resolved chain
	 * `POST /execute` runs (issue #1594) - see executeRequest.
	 */
	async startLoadTest(data: StartLoadTestRequest): Promise<StartLoadTestResponse> {
		return await httpClient.post<StartLoadTestResponse>(API_ENDPOINTS.START_LOAD_TEST, {
			...data,
			allowScriptRequests: true,
			origin: APP_ORIGIN,
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
			origin: APP_ORIGIN,
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
			before,
			type,
			status,
			requestId,
			collectionId,
			q,
			baseline,
			origin,
		} = params;
		// A cursor page has no offset to send; an explicit one still goes through
		// so the engine's `before_with_offset` 400 stays loud.
		const offset = params.offset ?? (before === undefined ? 0 : undefined);
		return await httpClient.get<RunListResponse>(
			API_ENDPOINTS.RUNS_LIST({
				limit,
				offset,
				before,
				type,
				status,
				requestId,
				collectionId,
				q,
				baseline,
				origin,
			})
		);
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
	 * Clear the run history in one engine pass. Pinned baselines and runs still
	 * in flight are kept (#2429); the answer names the ids that went.
	 */
	async clearRuns(): Promise<ClearRunsResponse> {
		return await httpClient.delete<ClearRunsResponse>(API_ENDPOINTS.RUNS);
	},

	/**
	 * Pin or unpin a run as the baseline for its request. Answers the updated
	 * list row, so a caller can patch its cached row instead of re-listing.
	 */
	async setRunBaseline(id: string, baseline: boolean): Promise<Run> {
		return await httpClient.put<Run>(API_ENDPOINTS.RUN_BASELINE(id), { baseline });
	},

	/**
	 * Get time-series metrics for a run: one page of raw ticks, or with
	 * `maxPoints` the whole series in one response, folded into buckets when the
	 * run has more ticks than that (#2547).
	 */
	async getRunTimeSeries(
		id: string,
		options: { limit?: number; offset?: number; maxPoints?: number } = {}
	): Promise<TimeSeriesResponse> {
		const { limit = STATS_PAGE_LIMIT, offset = 0, maxPoints } = options;
		return await httpClient.get<TimeSeriesResponse>(
			API_ENDPOINTS.STATS_TIME_SERIES(id, limit, offset, maxPoints)
		);
	},

	/** Server vitals for a run, paged or - with `maxPoints` - whole and folded (#2611). */
	async getRunMonitorSeries(
		id: string,
		options: { limit?: number; offset?: number; maxPoints?: number } = {}
	): Promise<MonitorSeriesResponse> {
		const { limit = STATS_PAGE_LIMIT, offset = 0, maxPoints } = options;
		return await httpClient.get<MonitorSeriesResponse>(
			API_ENDPOINTS.RUN_MONITOR(id, limit, offset, maxPoints)
		);
	},

	// Scripting
	async getScriptCompletions(): Promise<ScriptCompletionsResponse> {
		return await httpClient.get<ScriptCompletionsResponse>(API_ENDPOINTS.SCRIPT_COMPLETIONS);
	},

	async getScriptTypeDefinitions(): Promise<ScriptTypeDefinitionsResponse> {
		return await httpClient.get<ScriptTypeDefinitionsResponse>(API_ENDPOINTS.SCRIPT_TYPES);
	},

	// Elements
	async getElementKinds(): Promise<ElementKindSchema[]> {
		return await httpClient.get<ElementKindSchema[]>(API_ENDPOINTS.ELEMENT_KINDS);
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
	 *
	 * @param signal cancels the download (issue #893). Only the streamed form takes
	 * it: the buffered one is a single awaited POST whose caller has nothing to do
	 * while it runs, where a streamed one may be running behind a dialog the user
	 * has since closed - and then the engine is reading megabytes for nobody. An
	 * abort raises an `AbortError` rather than resolving, so a caller can tell its
	 * own cancel from a fetch that failed.
	 * @param onProgress called as the bytes arrive (issue #882). Its presence is
	 * what asks the engine to stream: without it this is the buffered call it has
	 * always been, which is what `ref-bundler` and the spec re-fetch want - they
	 * have nowhere to draw a bar and no reason to pay for a stream. With it the
	 * timeout becomes an *idle* one, so an 8 MB document arriving steadily is no
	 * longer racing {@link IMPORT_FETCH_BUDGET_MS}.
	 * @param options marks the fetch as a `$ref` a document asked for (issue
	 * #2364), which the engine holds to a stricter rule than a URL a person typed.
	 * Only `ref-bundler`'s fetches pass it; the body is otherwise exactly
	 * `{url}` / `{url, maxBytes}`.
	 */
	async importFetch(
		url: string,
		maxBytes?: number,
		onProgress?: (progress: ImportFetchProgress) => void,
		signal?: AbortSignal,
		options?: ImportFetchOptions
	): Promise<ImportFetchResponse> {
		const body = {
			url,
			...(maxBytes === undefined ? {} : { maxBytes }),
			...(options?.reference ? { reference: true } : {}),
			...(options?.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
		};
		if (!onProgress) {
			return await httpClient.post<ImportFetchResponse>(API_ENDPOINTS.IMPORT_FETCH, body, {
				timeout: IMPORT_FETCH_BUDGET_MS,
			});
		}

		for await (const message of httpClient.stream(API_ENDPOINTS.IMPORT_FETCH, body, {
			idleTimeout: IMPORT_FETCH_BUDGET_MS,
			...(signal ? { signal } : {}),
		})) {
			// An engine that has never heard of streaming answered the same request
			// the way it always has. Nothing was reported on the way, and there is
			// nothing to report now - but the document is here, which is what the
			// caller asked for.
			if (message.kind === "buffered") {
				return message.data as ImportFetchResponse;
			}
			if (message.event === IMPORT_FETCH_EVENTS.PROGRESS) {
				onProgress(message.data as ImportFetchProgress);
				continue;
			}
			if (message.event === IMPORT_FETCH_EVENTS.RESULT) {
				return message.data as ImportFetchResponse;
			}
			if (message.event === IMPORT_FETCH_EVENTS.ERROR) {
				// The only shape a streamed failure can arrive in: the status line
				// went on the 200 that opened the stream, so the event carries the
				// numeric status itself. Rethrown as the same `ApiError` the
				// buffered call would have thrown, so one `catch` handles both.
				const failure = message.data as {
					status: number;
					error: { code: string; message: string };
				};
				throw new ApiError(
					failure.status,
					failure.error.code,
					failure.error.message,
					failure
				);
			}
		}

		// The stream closed having said neither. Nothing was fetched, and calling
		// that an empty document would hand the parser a file the user never had.
		throw new Error("Vayu's engine ended the fetch without returning a document");
	},

	/**
	 * Parse a raw import document into the tree `applyImport` then persists
	 * (issue #877).
	 *
	 * **The app holds no parser any more.** Every format it accepts - OpenAPI
	 * 2.0/3.x, Postman v2.0/v2.1, a Postman environment or globals export,
	 * Insomnia v4 or v5 - is read here, by the same reader that answers what a stored
	 * document declares. That is what makes "exactly one parser has an opinion"
	 * true (#853): before this the renderer's `services/importers/` stack was
	 * the second reader, and an agent over MCP could bind, diff, sync and export
	 * a spec but could not import a document at all.
	 *
	 * Reads only - nothing is stored, so a preview costs no write.
	 */
	async parseImport(payload: ImportParseRequest): Promise<ImportResult> {
		return await httpClient.post<ImportResult>(API_ENDPOINTS.IMPORT_PARSE, payload);
	},

	/**
	 * A document's bytes as a JSON DOM, through the engine's reader.
	 *
	 * One caller: `ref-bundler.ts`, which walks a multi-file OpenAPI document to
	 * inline the files it references *before* anything is parsed or stored
	 * (issue #649). It needs a tree, and a YAML reader in the renderer to get
	 * one was the last thing keeping `js-yaml` in production `src/`. What a
	 * document *declares* is `describeSpec`; this is only what its bytes are.
	 */
	async readDocument(content: string): Promise<unknown> {
		const { document } = await httpClient.post<{ document: unknown }>(
			API_ENDPOINTS.IMPORT_DOCUMENT,
			{ content }
		);
		return document;
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
	// proxied timeout (as with executeRequest).
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
