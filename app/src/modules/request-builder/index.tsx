/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request builder's entry point, in the main content area: RequestBuilderProvider holds the
 * state, UrlBar the method, URL and Send, RequestTabs the request's configuration, and
 * ResponseViewer the response.
 */

import { useCallback, useMemo, useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RequestBuilderProvider, useRequestBuilderContext } from "./context";
import RequestBuilderLayout from "./components/RequestBuilderLayout";
import LoadTestConfigDialog from "./components/LoadTestConfigDialog";
import { wireTimings } from "./components/LoadTestConfigDialog/buildLoadTestConfig";
import RunCollectionDialog from "@/modules/collections/RunCollectionDialog";
import LoadTestCommandSurface from "./components/LoadTestCommandSurface";
import SendRequestCommandSurface from "./components/SendRequestCommandSurface";
import EditorDraftSurface from "./components/EditorDraftSurface";
import {
	canStartLoadRun,
	runningRunSentence,
	runningRunTab,
	useTabsStore,
	useSessionStore,
	useDashboardStore,
	useLayoutStore,
	useToastStore,
} from "@/stores";
import {
	useRequestQuery,
	isRequestNotFound,
	useUpdateRequestMutation,
	useCollectionAncestors,
	useElementKindsQuery,
	queryKeys,
} from "@/queries";
import { DetailSkeleton, EmptyState, ErrorState } from "@/components/shared";
import { ENGINE_NO_ANSWER } from "@/lib/engine-error-text";
import { Button } from "@/components/ui";
import { useCopy, useEngine, useVariableResolver, type ColumnAuditRequest } from "@/hooks";
import { humanizeOAuth2Error } from "@/constants/oauth2-fields";
import { DEFAULT_STREAM_FIRST_CONTENT_MARKER, DEFAULT_STREAM_TEXT_PATH } from "@/constants/request";
import { apiService, loadTestService } from "@/services";
import { generateCurl } from "@/services/codegen";
import type {
	RequestState,
	ResponseState,
	StreamStartResult,
	MergeableRequestField,
} from "./types";
import { keepSigningKeyReference } from "@/services/oauth/signing-key";
import { effectiveOAuth2Config, resolveAuthForSend } from "./utils/auth-resolution";
import { useOAuth2DeferredNames } from "./hooks/useOAuth2DeferredNames";
import {
	toKeyValueItems,
	toKeyValueEntries,
	withTrailingBlank,
} from "@/components/shared/KeyValueEditor/key-value";
import { toHeaderItems } from "./utils/system-headers";
import { mergeParamsFromUrl } from "./utils/url";
import { pathRowsOf, queryRowsOf } from "./utils/path-variables";
import type { ThresholdOwner } from "@/lib/agent-reference";
import { noFile } from "@/lib/file-trust";
import type { LeftOutElement } from "@/lib/elements";
import { toHeaderRows } from "./utils/key-value";
import {
	elementsParts,
	hasInlinePreScript,
	hasReplayedPostScript,
	hasUnmarkedPreScript,
	withoutDisabled,
	withoutInheritedCollectionOnly,
} from "./utils/elements-parts";
import { scenarioOnlyElements } from "./components/LoadTestConfigDialog/scenario-only";
import { buildComposeBody, withLeftOut } from "./utils/compose-body";
import { appendSendToConsole } from "@/modules/console";
import {
	disabledDefaults,
	streamFirstContentMarkerOf,
	streamTextPathOf,
	responseFromExecuteResult,
	elementsMayWriteVariables,
	responseCodeOfFailure,
	toBodyPayload,
} from "./utils/execute-mapping";
import type {
	FormFieldEntry,
	KeyValueItem,
	HttpMethod,
	LoadTestConfig,
	StartLoadTestRequest,
	OAuth2Config,
	UpdateRequestRequest,
	Collection,
} from "@/types";

/**
 * The PUT payload for exactly the changed fields (#1436): an untouched field is omitted, which the
 * engine's partial-update merge (`apply_request_fields`) reads as "leave it", not "clear it".
 * `changedFields` groups the four body-shaping fields under one write, since the wire's
 * `body`/`bodyType` is one value split across them in the editor's state.
 */
function buildUpdatePayload(
	requestId: string,
	request: RequestState,
	changedFields: ReadonlySet<MergeableRequestField>
): UpdateRequestRequest {
	const payload: UpdateRequestRequest = { id: requestId };

	if (changedFields.has("name")) {
		/*
		 * A blank name is refused, not saved (the Info tab's guard restores the stored name on
		 * blur). The debounced autosave can fire while the field is briefly empty, so the guard is
		 * here too: omitting the key keeps the stored name, where `""` would blank it everywhere
		 * the request is listed.
		 */
		const name = request.name.trim();
		if (name) payload.name = name;
	}
	if (changedFields.has("description")) payload.description = request.description;
	if (changedFields.has("method")) payload.method = request.method as HttpMethod;
	// `specOperation`'s null-vs-absent rule: untouched is omitted (keep), and leaving GraphQL or a
	// hand pick sets `undefined`, which must reach the wire as `null` or the engine reads "keep".
	if (changedFields.has("methodSource")) payload.methodSource = request.methodSource ?? null;
	if (changedFields.has("url")) payload.url = request.url;
	if (changedFields.has("params")) payload.params = toKeyValueEntries(request.params);
	// Only the user's rows: editor state holds nothing of Vayu's (#1229), so no filter is needed.
	// `disabledDefaultHeaders` is never sent: opt-outs belong to a send, and the defaults they
	// refuse are re-resolved from engine config each time.
	if (changedFields.has("headers")) payload.headers = toKeyValueEntries(request.headers);
	if (
		changedFields.has("bodyMode") ||
		changedFields.has("body") ||
		changedFields.has("formData") ||
		changedFields.has("urlEncoded") ||
		changedFields.has("binaryFile") ||
		changedFields.has("mcpTool")
	) {
		const bodyPayload = toBodyPayload(request);
		payload.body = bodyPayload;
		payload.bodyType = bodyPayload.mode;
	}
	if (changedFields.has("auth")) payload.auth = request.auth;
	/*
	 * The whole list when touched, `[]` included: `undefined` drops the key, and an absent key on a
	 * `PUT` keeps the stored value, so a list cleared to `[]` must be *sent*, which "touched"
	 * distinguishes from "never edited".
	 */
	if (changedFields.has("elements")) payload.elements = request.elements;
	if (changedFields.has("followRedirects")) payload.followRedirects = request.followRedirects;
	if (changedFields.has("maxRedirects")) payload.maxRedirects = request.maxRedirects;
	// A cleared field is an explicit `null`, since an absent key keeps the stored timeout (#2937,
	// the `methodSource` rule).
	if (changedFields.has("timeout")) payload.timeout = request.timeout ?? null;
	if (changedFields.has("httpVersion")) payload.httpVersion = request.httpVersion;
	if (changedFields.has("verifySSL")) payload.verifySSL = request.verifySSL;
	if (changedFields.has("disableCookies")) payload.disableCookies = request.disableCookies;
	// The *stored* automatic-header list (#1765), edited in Settings, unlike the per-send
	// `disabledDefaultHeaders`; sent whole, `[]` included, for the `elements` reason.
	if (changedFields.has("disabledSystemHeaders"))
		payload.disabledSystemHeaders = request.disabledSystemHeaders;
	if (changedFields.has("disableUrlEncoding"))
		payload.disableUrlEncoding = request.disableUrlEncoding;
	if (changedFields.has("stream")) payload.stream = request.stream;
	// A cleared field is an explicit `null` (the `timeout` rule): an absent key keeps the path
	// (#3773).
	if (changedFields.has("streamTextPath"))
		payload.streamTextPath = request.streamTextPath.trim() || null;
	if (changedFields.has("streamFirstContentMarker"))
		payload.streamFirstContentMarker = request.streamFirstContentMarker || null;

	return payload;
}

/**
 * The stored params as draft rows. A query only in the URL (stored with no `params`) gets rows
 * here, or the table opens empty and its first edit drops that query from the URL (#3491).
 * `baseline` is seeded from the same value, so the rows do not dirty the draft. The query's spare
 * row sits ahead of the path rows, where the table's edits leave it, so a refetch can hand it the
 * draft's spare row id (`carryRowIds`, #3663).
 */
function paramsDraftRows(stored: FormFieldEntry[], url: string): KeyValueItem[] {
	const rows = mergeParamsFromUrl(toKeyValueItems(stored), url, url);
	return [...withTrailingBlank(queryRowsOf(rows)), ...pathRowsOf(rows)];
}

/**
 * The pane a dirty tab falls back to when its request is deleted elsewhere (#1436). This file keeps
 * `RequestBuilderProvider` mounted for it, so the draft is reachable through context: a copy of the
 * user's work, not a 404 toast from a doomed autosave.
 */
function DeletedRequestBanner({ onCloseTab }: { onCloseTab?: () => void }) {
	const { request } = useRequestBuilderContext();
	const showToast = useToastStore((s) => s.showToast);
	const { copy } = useCopy();

	const handleCopyCurl = useCallback(async () => {
		try {
			const snippet = generateCurl({
				method: request.method,
				url: request.url,
				params: request.params,
				headers: toHeaderRows(request.headers),
				body: toBodyPayload(request),
				/*
				 * The collection the auth might inherit from cannot be looked up now, so `inherit`
				 * resolves to nothing rather than guessing, as for an empty ancestor chain.
				 */
				auth: resolveAuthForSend(request.auth, []),
				stream: request.stream,
				verifySSL: request.verifySSL,
				followRedirects: request.followRedirects,
				maxRedirects: request.maxRedirects,
				timeout: request.timeout,
				httpVersion: request.httpVersion,
				disableUrlEncoding: request.disableUrlEncoding,
			});
			// A text button, so the acknowledgement is the toast, not a check swap
			// (design-system/feedback-and-dashboard.md, Component Patterns); `useCopy` owns the
			// failure path.
			await copy(snippet.code, "cURL command");
		} catch (error) {
			console.error("Failed to build the request as curl:", error);
			showToast("Couldn't build the cURL command.", "error");
		}
	}, [copy, request, showToast]);

	return (
		<ErrorState
			title="This request no longer exists"
			detail="It was deleted, or the collection it lived in was. Your edits are still here - copy them out before closing the tab. If it is in the Trash, restoring it there brings this tab back."
			action={
				<div className="flex gap-2">
					<Button variant="outline" size="sm" onClick={handleCopyCurl}>
						Copy as cURL
					</Button>
					{onCloseTab && (
						<Button variant="outline" size="sm" onClick={onCloseTab}>
							Close tab
						</Button>
					)}
				</div>
			}
		/>
	);
}

/** Reads the request id from the tab store, fetches the request, and provides the context. */
export default function RequestBuilder() {
	const openTabs = useTabsStore((s) => s.openTabs);
	const activeTabId = useTabsStore((s) => s.activeTabId);
	const openTab = useTabsStore((s) => s.openTab);
	const closeTab = useTabsStore((s) => s.closeTab);
	// A request is picked from the Collections drawer, so the "nothing selected" pane sends you
	// there.
	const revealDrawerView = useLayoutStore((s) => s.revealDrawerView);
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const startRun = useDashboardStore((s) => s.startRun);
	const showToast = useToastStore((s) => s.showToast);
	const { executeRequest: engineExecuteRequest, composeRequest: engineComposeRequest } =
		useEngine();
	const updateRequestMutation = useUpdateRequestMutation();
	const queryClient = useQueryClient();

	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedRequestId = activeTab?.type === "request" ? activeTab.entityId : null;

	const [showLoadTestDialog, setShowLoadTestDialog] = useState(false);
	const [isStartingLoadTest, setIsStartingLoadTest] = useState(false);
	const [pendingLoadTestRequest, setPendingLoadTestRequest] = useState<RequestState | null>(null);
	// The collection-run dialog the load dialog hands over to (#3050), mounted only with a
	// collection set.
	const [runCollectionTarget, setRunCollectionTarget] = useState<Collection | null>(null);

	const {
		data: fetchedRequest,
		isLoading,
		isError,
		error: requestLookupError,
		refetch,
	} = useRequestQuery(selectedRequestId);

	// The collection being worked in, for the welcome screen to place a new request; from the
	// loaded request, whose `collectionId` is authoritative, not a possibly stale tab-focus cache
	// peek.
	const setLastCollectionId = useSessionStore((s) => s.setLastCollectionId);
	useEffect(() => {
		if (fetchedRequest?.collectionId) setLastCollectionId(fetchedRequest.collectionId);
	}, [fetchedRequest?.collectionId, setLastCollectionId]);

	/*
	 * Whether this tab ever saw its request load, over the tab's life (#1436): a 404 after a load
	 * is a deletion with a draft to offer; a 404 on the first fetch (a bad id, a long-gone row) has
	 * none and gets the plain "no longer exists" pane. Adjusted during render, like the provider's
	 * reset gates: state derived from the query, where a ref read would break the same rule (a
	 * render can be discarded or replayed, a ref cannot).
	 */
	const [hadRequestFor, setHadRequestFor] = useState({ id: selectedRequestId, had: false });
	if (hadRequestFor.id !== selectedRequestId) {
		setHadRequestFor({ id: selectedRequestId, had: !!fetchedRequest });
	} else if (fetchedRequest && !hadRequestFor.had) {
		setHadRequestFor((prev) => ({ ...prev, had: true }));
	}

	// The current collection's ancestor chain, root first.
	const collectionAncestors = useCollectionAncestors(fetchedRequest?.collectionId);

	// The variable resolver, preview-only (#226): execution resolves engine-side (POST /compose).
	// `resolveObject` still backs the load dialog's OAuth expiry guard, which previews without
	// sending.
	const { resolveObject, resolveString } = useVariableResolver({
		collectionId: fetchedRequest?.collectionId || undefined,
	});

	// The elements a load run of the pending request resolves, inherited ones included: the dialog
	// warns about what the run composes.
	const pendingLoadTestParts = useMemo(
		() =>
			pendingLoadTestRequest
				? elementsParts(
						collectionAncestors,
						fetchedRequest?.id,
						pendingLoadTestRequest.elements
					)
				: undefined,
		[pendingLoadTestRequest, collectionAncestors, fetchedRequest?.id]
	);
	const pendingScenarioOnlyElements = useMemo(
		() => scenarioOnlyElements(pendingLoadTestParts),
		[pendingLoadTestParts]
	);

	// The pending load-test request's OAuth 2.0 config as written, if its auth resolves to oauth2.
	// The shared walk lets an ancestor set to No Auth stop the search, or the guard would fetch a
	// token never sent.
	const pendingOAuth2Raw = useMemo(
		() =>
			pendingLoadTestRequest
				? effectiveOAuth2Config(pendingLoadTestRequest.auth, collectionAncestors)
				: null,
		[pendingLoadTestRequest, collectionAncestors]
	);

	// The pending load-test request's variable-resolved OAuth 2.0 config, for the token-expiry
	// guard.
	const pendingOAuth2Config = useMemo(
		() =>
			pendingOAuth2Raw
				? keepSigningKeyReference(
						resolveObject(pendingOAuth2Raw) as OAuth2Config,
						pendingOAuth2Raw
					)
				: null,
		[pendingOAuth2Raw, resolveObject]
	);

	// Asked only while the dialog is open: a load run fetches its token once, before any script,
	// and this feeds the note saying so.
	const pendingOAuth2DeferredNames = useOAuth2DeferredNames(
		fetchedRequest?.id ?? "",
		pendingOAuth2Raw,
		showLoadTestDialog
	);

	// The URL the dialog names as target and classifies for its off-network advisory (#2117),
	// resolved from the preview's scopes, so a valueless `{{baseUrl}}` stays a token and reads as
	// unknown.
	const pendingLoadTestUrl = useMemo(
		() => (pendingLoadTestRequest ? resolveString(pendingLoadTestRequest.url) : undefined),
		[pendingLoadTestRequest, resolveString]
	);

	// The pending load-test request in stored-row shapes, for the load dialog's data-column audit
	// (#2050); the draft, as that is what the run sends.
	const pendingLoadTestAuditRequest = useMemo<ColumnAuditRequest | undefined>(
		() =>
			pendingLoadTestRequest
				? {
						url: pendingLoadTestRequest.url,
						params: toKeyValueEntries(pendingLoadTestRequest.params),
						headers: toKeyValueEntries(pendingLoadTestRequest.headers),
						body: toBodyPayload(pendingLoadTestRequest),
						elements: pendingLoadTestRequest.elements,
						auth: pendingLoadTestRequest.auth,
					}
				: undefined,
		[pendingLoadTestRequest]
	);

	// The saved row names the request in a budget's "Copy for agent" (#2047).
	const savedRequestId = fetchedRequest?.id;
	const savedRequestName = fetchedRequest?.name;
	const collectionPath = useMemo(
		() => collectionAncestors.map((collection) => collection.name),
		[collectionAncestors]
	);
	const thresholdOwner = useMemo<ThresholdOwner | undefined>(
		() =>
			savedRequestId !== undefined && savedRequestName !== undefined
				? { type: "request", request: { id: savedRequestId, name: savedRequestName } }
				: undefined,
		[savedRequestId, savedRequestName]
	);

	const initialRequest = useMemo((): Partial<RequestState> | undefined => {
		if (!fetchedRequest) return undefined;

		const body = fetchedRequest.body;
		// The stored mode is the editor's, one for one; no mapping can turn an unnamed new mode
		// into "none".
		const bodyMode = body.mode;

		const rawBody = "content" in body ? body.content : "";

		return {
			id: fetchedRequest.id,
			name: fetchedRequest.name,
			description: fetchedRequest.description,
			method: fetchedRequest.method,
			methodSource: fetchedRequest.methodSource,
			url: fetchedRequest.url,
			params: paramsDraftRows(fetchedRequest.params, fetchedRequest.url),
			headers: toHeaderItems(fetchedRequest.headers),
			bodyMode,
			body: rawBody,
			/*
			 * A request stores one body, so the record says nothing of other modes: naming their
			 * keys empty made a save's echo read as "formData is now []", which the merge adopted
			 * over the draft's rows (#3665). Absent keys let `{ ...baseline, ...initialRequest }`
			 * keep the draft's own. The test is the stored mode, not content: an empty form-data
			 * body is still the record's answer.
			 */
			...(body.mode === "form-data" && { formData: toKeyValueItems(body.fields) }),
			...(body.mode === "x-www-form-urlencoded" && {
				urlEncoded: toKeyValueItems(body.fields),
			}),
			...(body.mode === "binary" && { binaryFile: body.file ?? noFile() }),
			// For the stored mcp body only, as above, even without a tool: an external write
			// removing one must reach the draft as "none".
			...(body.mode === "mcp" && { mcpTool: body.mcpTool }),
			auth: fetchedRequest.auth,
			elements: fetchedRequest.elements,
			followRedirects: fetchedRequest.followRedirects,
			maxRedirects: fetchedRequest.maxRedirects,
			timeout: fetchedRequest.timeout,
			httpVersion: fetchedRequest.httpVersion,
			verifySSL: fetchedRequest.verifySSL,
			disableCookies: fetchedRequest.disableCookies,
			disabledSystemHeaders: fetchedRequest.disabledSystemHeaders,
			disableUrlEncoding: fetchedRequest.disableUrlEncoding,
			stream: fetchedRequest.stream,
			streamTextPath: fetchedRequest.streamTextPath ?? DEFAULT_STREAM_TEXT_PATH,
			streamFirstContentMarker:
				fetchedRequest.streamFirstContentMarker ?? DEFAULT_STREAM_FIRST_CONTENT_MARKER,
			collectionId: fetchedRequest.collectionId,
		};
	}, [fetchedRequest]);

	// Judges the draft's elements at Send (#3066) by the Elements tab's schemas; `ElementsPanel`
	// fetches it, so this is a cache read.
	const { data: elementKinds } = useElementKindsQuery();

	/**
	 * The compose body a Send puts on the wire, the script parts in it, and the draft elements it
	 * leaves out (`leftOut`, #3066). Shared by the buffered and streaming send (#574): everything
	 * up to the endpoint answer must be identical, or a stream would measure another request. Built
	 * apart from the engine-side composition, so a handler holds `leftOut` before that can fail: a
	 * failed send still says what it left out. `collectionAncestors` is the live chain, so a
	 * stream's refusal for carrying scripts follows what the send *would* run. `dataRow` (#601)
	 * matters to composition only for its *names* (`dataColumns` below).
	 */
	const buildSendBody = useCallback(
		(
			request: RequestState,
			ownerId: string,
			ownerCollectionId: string,
			dataRow?: Record<string, unknown>
		) =>
			buildComposeBody({
				request,
				// Unfinished draft elements stay out of the payload (#3066), as in the Code
				// section; an unloaded catalogue judges what it can.
				elements: {
					chain: collectionAncestors,
					ownerId,
					onlyRunnable: { kinds: elementKinds ?? [] },
				},
				collectionId: ownerCollectionId,
				environmentId: activeEnvironmentId,
				// The row's keys, exactly the set the engine's bind reads back (#1007): a
				// Postman-style `{{username}}` must survive composition to reach that bind. Absent
				// for an ordinary Send.
				dataColumns: dataRow ? Object.keys(dataRow) : undefined,
			}),
		[collectionAncestors, activeEnvironmentId, elementKinds]
	);

	const handleExecute = useCallback(
		async (
			request: RequestState,
			dataRow?: Record<string, unknown>,
			signal?: AbortSignal
		): Promise<ResponseState | null> => {
			if (!fetchedRequest) return null;

			// Outside the try: a failed send still left these out.
			let leftOut: LeftOutElement[] = [];
			try {
				const built = buildSendBody(
					request,
					fetchedRequest.id,
					fetchedRequest.collectionId,
					dataRow
				);
				const { elements } = built;
				leftOut = built.leftOut;
				const composed = await engineComposeRequest(built.body);

				const result = await engineExecuteRequest(
					// `stream: false` explicitly: the endpoint's two answers are different
					// *shapes*, so which comes back is no decision for an engine default
					// (`ExecuteRequestRequest.stream`).
					{
						...composed,
						requestId: fetchedRequest.id,
						stream: false,
						// The defaults this send refuses (#1229), beside the composed payload, not
						// through it: what the engine adds is decided at send time from config, so
						// the opt-out is the send's. Omitted when none.
						...disabledDefaults(request),
						// A Send-with-row's row, or nothing (#601), beside the composed payload:
						// `{{data.*}}` survives compose by design, so the tokens are still written
						// when the engine binds here.
						...(dataRow ? { data: dataRow } : {}),
					},
					activeEnvironmentId || undefined,
					signal
				);

				// Before the cancelled-send exit: Cancel only stops waiting, the engine still runs
				// and records the request (#3352). The context bar's Recent sends is not polled, so
				// it would otherwise keep showing older sends; the history list has its own 5s
				// poll.
				queryClient.invalidateQueries({
					queryKey: queryKeys.runs.recentDesign(fetchedRequest.id),
				});

				// Refresh variables so script-set values (`pm.environment.set`) appear; an
				// extractor's `scope` writes them too (see the helper).
				if (elementsMayWriteVariables(elements)) {
					queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
					queryClient.invalidateQueries({ queryKey: queryKeys.globals.all });
					queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
				}

				if (!result) return null;

				// The engine could not fetch an OAuth 2.0 token non-interactively: the response
				// renders its error, and the toast points at the fix.
				if (result.errorCode === "AUTH_REQUIRED") {
					showToast(
						"This request needs an OAuth 2.0 token. Open the Auth tab to get one.",
						"error"
					);
				} else if (result.errorCode === "AUTH_FAILED") {
					// The engine's message names JSON fields (accessTokenUrl); the form labels them
					// (Access Token URL).
					showToast(
						result.errorMessage
							? humanizeOAuth2Error(result.errorMessage)
							: "Couldn't get an OAuth 2.0 token. Check the Auth tab's token settings.",
						"error"
					);
				}

				// Shared with the History run view's send path (execute-mapping.ts).
				const response = responseFromExecuteResult(result);
				// A session send, so the Console lists it (#3634); a History replay maps its answer
				// without this. The answer's method and URL are what was dialled after any script
				// retargeting; the composed ones stand in for an older engine. `runId` is the run
				// the engine recorded (#3679), absent for a transient send: it is what "Open run"
				// opens.
				appendSendToConsole({
					method: result.method ?? composed.method,
					url: result.url ?? composed.url,
					response,
					requestId: fetchedRequest.id,
					runId: result.runId,
				});
				return withLeftOut(response, leftOut);
			} catch (error) {
				console.error("Execute request failed:", error);
				const errorMsg = error instanceof Error ? error.message : String(error);
				const failed: ResponseState = {
					status: 0,
					statusText: "Error",
					headers: {},
					body: errorMsg,
					time: 0,
					size: 0,
					// Compose runs first, so a down engine throws here before any send, a plain
					// fetch Error, not an `ApiError`; `useEngine`'s `executeRequest` follows the
					// same rule.
					errorCode: responseCodeOfFailure(error),
					errorMessage: errorMsg,
				};
				// A Send that got no answer is still listed by the Console (#3634), as written:
				// nothing composed.
				appendSendToConsole({
					method: request.method,
					url: request.url,
					response: failed,
					requestId: fetchedRequest.id,
				});
				return withLeftOut(failed, leftOut);
			}
		},
		[
			fetchedRequest,
			buildSendBody,
			engineComposeRequest,
			engineExecuteRequest,
			activeEnvironmentId,
			queryClient,
			showToast,
		]
	);

	/**
	 * Start a stream-flagged send (#574): the buffered path's composition exactly, with
	 * `202 {runId, eventsUrl}` and no exchange; the provider registers the stream and the events
	 * hook tails it. A refusal returns as a response to render, not a swallowed error: the engine's
	 * refusals here need reading (a stream cannot carry scripts, including the chain's), so the
	 * message fills the response pane and repeats as a toast, since the pane is easy to miss from
	 * the Events tab.
	 */
	const handleExecuteStream = useCallback(
		async (
			request: RequestState,
			dataRow?: Record<string, unknown>
		): Promise<StreamStartResult | null> => {
			if (!fetchedRequest) return null;

			// Outside the try: a failed send still left these out.
			let leftOut: LeftOutElement[] = [];
			try {
				const built = buildSendBody(
					request,
					fetchedRequest.id,
					fetchedRequest.collectionId,
					dataRow
				);
				leftOut = built.leftOut;
				const composed = await engineComposeRequest(built.body);

				const started = await apiService.executeStreamRequest({
					...composed,
					requestId: fetchedRequest.id,
					environmentId: activeEnvironmentId || undefined,
					// The buffered send's opt-out: a stream must not carry a header set the
					// buffered send would not.
					...disabledDefaults(request),
					// The inline compose carries no text path, so the send states it.
					...streamTextPathOf(request),
					// A stream binds a row as a buffered send does; the engine reads it before the
					// transfer, so the URL and headers it opens with are bound (#601).
					...(dataRow ? { data: dataRow } : {}),
				});

				// A stream is a design run, so Recent sends (not polled) is told now: the run
				// exists from here, not from when the stream ends.
				queryClient.invalidateQueries({
					queryKey: queryKeys.runs.recentDesign(fetchedRequest.id),
				});

				return { ok: true, runId: started.runId, eventsUrl: started.eventsUrl, leftOut };
			} catch (error) {
				console.error("Stream request failed:", error);
				const errorMsg = error instanceof Error ? error.message : String(error);
				showToast(errorMsg, "error");
				const failed: ResponseState = {
					status: 0,
					statusText: "Error",
					headers: {},
					body: errorMsg,
					time: 0,
					size: 0,
					errorCode: responseCodeOfFailure(error),
					errorMessage: errorMsg,
				};
				// A refused stream is listed like a buffered Send with no answer (#3634): no stream
				// opens, so `finalizeStreamRun` never appends it.
				appendSendToConsole({
					method: request.method,
					url: request.url,
					response: failed,
					requestId: fetchedRequest.id,
				});
				return { ok: false, response: withLeftOut(failed, leftOut) };
			}
		},
		[
			fetchedRequest,
			buildSendBody,
			engineComposeRequest,
			activeEnvironmentId,
			queryClient,
			showToast,
		]
	);

	// Saves only the fields changed since the draft's last known-good value (#1436); see
	// `buildUpdatePayload`.
	const handleSave = useCallback(
		async (request: RequestState, changedFields: ReadonlySet<MergeableRequestField>) => {
			if (!fetchedRequest || changedFields.size === 0) return;
			await updateRequestMutation.mutateAsync(
				buildUpdatePayload(fetchedRequest.id, request, changedFields)
			);
		},
		[fetchedRequest, updateRequestMutation]
	);

	/*
	 * `canStartLoadRun` (#3351): while a run holds the stream, open it and name it instead of
	 * starting another; true when it refused. Load runs only: a streaming design request (#574)
	 * does not block one, holding one consumer on one run and reporting into the response pane,
	 * while a load run owns the dashboard; neither can read the other's numbers.
	 */
	const refuseWhileRunLive = useCallback((): boolean => {
		const gate = canStartLoadRun();
		if (gate.ok) return false;
		openTab(runningRunTab(gate.running));
		showToast(runningRunSentence(gate.running), "warning");
		return true;
	}, [openTab, showToast]);

	// Start a load test: shows the config dialog.
	const handleStartLoadTest = useCallback(
		(request: RequestState) => {
			if (refuseWhileRunLive()) return;
			setPendingLoadTestRequest(request);
			setShowLoadTestDialog(true);
		},
		[refuseWhileRunLive]
	);

	const handleConfirmLoadTest = useCallback(
		async (config: LoadTestConfig) => {
			if (!pendingLoadTestRequest || !fetchedRequest) return;

			// Again, for a run that started while the dialog was open.
			if (refuseWhileRunLive()) {
				setShowLoadTestDialog(false);
				return;
			}

			setIsStartingLoadTest(true);
			try {
				// The request half through Send's builder, so a load test measures the request Send
				// sends: one Settings tab governs both, and the dialog decides load shape only. Its
				// resolved elements go to `POST /runs` as `requestElements` (#1594): the
				// single-request load path runs `extract.*` / `assert.*` inline and `timer.think` /
				// `script.*` per `elements.scripts`. A key apart from `elements` (the run-level
				// override), since the flat payload has no `request` sub-object.
				const { body, elements: requestElements } = buildComposeBody({
					request: pendingLoadTestRequest,
					elements: { chain: collectionAncestors, ownerId: fetchedRequest.id },
					collectionId: fetchedRequest.collectionId,
					environmentId: activeEnvironmentId,
					// The picked file's columns (#1007). This composition precedes `POST /runs`,
					// the only place a bare `{{username}}` can be left for the per-iteration bind
					// instead of resolved from the environment. Absent whenever `config.data` is.
					dataColumns: config.dataColumns,
					// The payload repeats per iteration and virtual user, so the `{{$guid}}` family
					// belongs to each repetition, not the one composition (#995).
					deferDynamicVariables: true,
				});

				// Compose engine-side, then start the run with the composed request half plus the
				// load shape, never re-resolved.
				const composed = await engineComposeRequest(body);

				const apiRequest: StartLoadTestRequest = {
					...(composed as unknown as StartLoadTestRequest),
					mode: config.mode,
					...wireTimings(config),
					targetRps: config.rps,
					iterations: config.iterations,
					concurrency: config.concurrency,
					// Ramp-Up only; unset, every ramp starts from the engine default of 1.
					startConcurrency: config.start_concurrency,
					// Capacity only. `startConcurrency` is where the search begins and
					// `concurrency` its ceiling, so the mode adds only `sloMs` and the step
					// duration (in `wireTimings`), not a second spelling of bounds.
					sloMs: config.slo_ms,
					maxInFlight: config.max_in_flight,
					// A load run of a streaming request streams (#576), read off the request, not
					// the dialog, and sent as `false`, not elided: the composed payload may carry a
					// stale flag, and an omitted `false` reads as "unset", not "no".
					stream: pendingLoadTestRequest.stream ?? false,
					// The stream caps (duration is in `wireTimings`, in ms), only for a streaming
					// run: the engine refuses a cap without `stream`, so an unbounded run is not
					// mistaken for a capped one.
					maxStreamEvents: config.stream_max_events,
					requestId: fetchedRequest.id,
					environmentId: activeEnvironmentId || undefined,
					comment: config.comment,
					// The resolved chain composed above (#1594), never the spread's `elements`:
					// that is the composed list, while `elements` on `POST /runs` is the run-level
					// override object the Scripts control writes, and the two must not collide.
					// Disabled elements are left out (#3050): skipped anyway, and a scenario-only
					// kind among them must not refuse the run. Nor goes a collection's setup /
					// teardown script (#3070): a single-request run never takes one, and the engine
					// refuses it on a request.
					requestElements: withoutInheritedCollectionOnly(
						withoutDisabled(requestElements)
					),
					elements: config.elements,
					success_sample_rate: config.success_sample_period,
					slow_threshold_ms: config.slow_threshold_ms,
					save_timing_breakdown: config.save_timing_breakdown,
					retryAfterBackoff: config.retryAfterBackoff,
					retryAfterMaxMs: config.retryAfterMaxMs,
					// Undefined without budgets: the engine refuses an empty `thresholds` rather
					// than start an unjudged run.
					thresholds: config.thresholds,
					carriedBudgets: config.carriedBudgets,
					// Undefined without a metrics endpoint, for the same reason.
					monitor: config.monitor,
					// The rows the picker parsed (#993), bound one per submission; undefined with
					// no file, since an empty array is refused, so "no data set" is the absent key.
					data: config.data,
					// The rows' file (#2051): name and content hash, never the path, and how it was
					// read (#2540). Undefined exactly when `data` is.
					dataFileName: config.dataFileName,
					dataFileHash: config.dataFileHash,
					dataFileCastNumbers: config.dataFileCastNumbers,
					// The defaults this run refuses (#1229): a load run must send Send's header
					// set, or it measures another request.
					...disabledDefaults(pendingLoadTestRequest),
					// The text path a streaming run reads events through (#3773), from the request
					// like `stream`.
					...streamTextPathOf(pendingLoadTestRequest),
					// The literal the run times streams to (#3774): load runs only, as a Send has
					// no reader for it.
					...streamFirstContentMarkerOf(pendingLoadTestRequest),
				};

				const result = await apiService.startLoadTest(apiRequest);

				// Set the active run and open the dashboard, with config and request info for the
				// live view.
				startRun(
					result.runId,
					{
						mode: apiRequest.mode,
						duration: apiRequest.duration,
						targetRps: apiRequest.targetRps,
						concurrency: apiRequest.concurrency,
						iterations: apiRequest.iterations,
						comment: apiRequest.comment,
						rampUpDuration: apiRequest.rampUpDuration,
						startConcurrency: apiRequest.startConcurrency,
						sloMs: apiRequest.sloMs,
						latencyP99Ms: apiRequest.thresholds?.latencyP99Ms,
						dataRowCount: config.data?.length,
						dataFileName: config.dataFileName,
						dataFileHash: config.dataFileHash,
						dataFileCastNumbers: config.dataFileCastNumbers,
					},
					{
						method: apiRequest.method,
						url: apiRequest.url,
					},
					fetchedRequest.id
				);

				// Global metrics monitoring, active even if the user navigates away.
				loadTestService.startMonitoring(result.runId);

				openTab({ type: "dashboard", entityId: null });
				setShowLoadTestDialog(false);
				setPendingLoadTestRequest(null);
			} catch (error) {
				console.error("Failed to start load test:", error);
				showToast(
					error instanceof Error
						? `Couldn't start the load test - ${error.message}`
						: "Couldn't start the load test.",
					"error"
				);
			} finally {
				setIsStartingLoadTest(false);
			}
		},
		[
			pendingLoadTestRequest,
			fetchedRequest,
			activeEnvironmentId,
			startRun,
			openTab,
			showToast,
			engineComposeRequest,
			collectionAncestors,
			refuseWhileRunLive,
		]
	);

	const handleCloseLoadTestDialog = useCallback(() => {
		setShowLoadTestDialog(false);
		setPendingLoadTestRequest(null);
	}, []);

	// The request's own collection is the last link of the root-first chain.
	const requestCollection = collectionAncestors[collectionAncestors.length - 1];
	const handleRunCollectionInstead = useCallback(() => {
		if (!requestCollection) return;
		handleCloseLoadTestDialog();
		setRunCollectionTarget(requestCollection);
	}, [requestCollection, handleCloseLoadTestDialog]);

	if (!selectedRequestId) {
		return (
			<EmptyState
				title="Select a request to get started"
				action={
					<Button variant="link" onClick={() => revealDrawerView("collections")}>
						Browse collections
					</Button>
				}
			/>
		);
	}

	if (isLoading) {
		return <DetailSkeleton label="Loading request" />;
	}

	/*
	 * The lookup errored, and the two causes need different panes. `GET /requests/:id` throws the
	 * `RequestNotFoundError` sentinel for a genuine deletion, which is authoritative: say it is
	 * gone, and offer no retry (a 404 only 404s again). Any other failure (a 5xx, an engine not up
	 * yet) means the request is likely there and only the lookup failed; "no longer exists" would
	 * be a lie inviting a close. Discriminated by type, never message, as in `DesignRunView`.
	 * Deleting a request closes its tabs (`closeTabsForEntities`), so this branch usually means
	 * another window or a restored database. The delete is soft, so the pane points at the Trash
	 * (#3449): a restore invalidates `requests.all`, holding this tab's query, so it loads again.
	 */
	const requestWasDeleted =
		isRequestNotFound(requestLookupError) || (!isError && !fetchedRequest);
	/*
	 * A deletion this tab was open for keeps its draft (#1436): the provider stays mounted instead
	 * of the not-found pane, so `DeletedRequestBanner` can offer `request`. A first-load 404 or any
	 * other error gets the full-pane swap: there is no draft either way.
	 */
	const deletedWithDraft = requestWasDeleted && hadRequestFor.had;
	if ((isError || !fetchedRequest) && !deletedWithDraft) {
		const closeTabAction = activeTab ? (
			<Button variant="outline" size="sm" onClick={() => closeTab(activeTab.id)}>
				Close tab
			</Button>
		) : undefined;

		return requestWasDeleted ? (
			<ErrorState
				title="This request no longer exists"
				detail="It was deleted, or the collection it lived in was. It may be in the Trash - restoring it there brings this tab back."
				action={closeTabAction}
			/>
		) : (
			<ErrorState
				title="Couldn't load this request"
				detail={
					requestLookupError instanceof Error && requestLookupError.message
						? requestLookupError.message
						: ENGINE_NO_ANSWER
				}
				onRetry={() => refetch()}
				action={closeTabAction}
			/>
		);
	}

	return (
		<>
			<RequestBuilderProvider
				initialRequest={initialRequest}
				collectionId={fetchedRequest?.collectionId ?? null}
				onExecute={handleExecute}
				onExecuteStream={handleExecuteStream}
				onSave={handleSave}
				onStartLoadTest={handleStartLoadTest}
			>
				{deletedWithDraft ? (
					<DeletedRequestBanner
						onCloseTab={activeTab ? () => closeTab(activeTab.id) : undefined}
					/>
				) : (
					<>
						<RequestBuilderLayout />
						{/*
						 * Render nothing; they publish the live draft, so the palette's
						 * `Load test …` and `Send …` and the context bar's Code section act on the
						 * request as edited, not as last saved.
						 */}
						<LoadTestCommandSurface />
						<SendRequestCommandSurface />
						<EditorDraftSurface />
					</>
				)}
			</RequestBuilderProvider>

			{showLoadTestDialog && (
				<LoadTestConfigDialog
					onClose={handleCloseLoadTestDialog}
					onStart={handleConfirmLoadTest}
					isStarting={isStartingLoadTest}
					hasPreRequestScript={hasUnmarkedPreScript(pendingLoadTestRequest?.elements)}
					hasInlinePreScript={hasInlinePreScript(pendingLoadTestRequest?.elements)}
					hasPostRequestScript={hasReplayedPostScript(pendingLoadTestParts)}
					scenarioOnlyElements={pendingScenarioOnlyElements}
					onRunCollection={requestCollection ? handleRunCollectionInstead : undefined}
					oauth2Config={pendingOAuth2Config ?? undefined}
					oauth2DeferredNames={pendingOAuth2DeferredNames}
					isStreamingRequest={!!pendingLoadTestRequest?.stream}
					collectionId={fetchedRequest?.collectionId}
					request={pendingLoadTestAuditRequest}
					referenceOwner={thresholdOwner}
					collectionPath={collectionPath}
					method={pendingLoadTestRequest?.method}
					url={pendingLoadTestUrl}
				/>
			)}

			{runCollectionTarget && (
				<RunCollectionDialog
					collection={runCollectionTarget}
					onOpenChange={(open) => !open && setRunCollectionTarget(null)}
				/>
			)}
		</>
	);
}

// Types re-exported for external use. Not the context hook: consumers import it from `./context`,
// and a value export beside the component would cost this file fast refresh.
export type { RequestState, ResponseState } from "./types";
