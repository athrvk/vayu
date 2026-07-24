/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestBuilder - Main Container Component
 *
 * Location: Main content area only
 *
 * This is the main entry point for the RequestBuilder module.
 * It composes all sub-components and provides the context.
 *
 * Architecture:
 * - RequestBuilderProvider wraps everything for state management
 * - UrlBar handles method selection, URL input, and send button
 * - RequestTabs handles request configuration (params, headers, body, etc.)
 * - ResponseViewer displays the response
 */

import { useCallback, useMemo, useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RequestBuilderProvider } from "./context";
import RequestBuilderLayout from "./components/RequestBuilderLayout";
import LoadTestConfigDialog from "./components/LoadTestConfigDialog";
import { useTabsStore, useSessionStore, useDashboardStore, useToastStore } from "@/stores";
import {
	useRequestQuery,
	useUpdateRequestMutation,
	useCollectionAncestors,
	queryKeys,
} from "@/queries";
import { EmptyState, ErrorState } from "@/components/shared";
import { Button } from "@/components/ui";
import { useEngine, useVariableResolver } from "@/hooks";
import { apiService, loadTestService } from "@/services";
import type { RequestState, ResponseState } from "./types";
import {
	authToEditor,
	editorToAuth,
	resolveInheritedAuth,
	authToRecord,
} from "./utils/auth-mapping";
import { toKeyValueItems, toKeyValueEntries, toFlatHeaders } from "./utils/key-value";
import { generateUUID } from "./utils/id";
import { scriptParts } from "./utils/script-parts";
import { buildExecBody, responseFromExecuteResult } from "./utils/execute-mapping";
import type {
	HttpMethod,
	LoadTestConfig,
	StartLoadTestRequest,
	RequestBody,
	RequestAuth,
	OAuth2Config,
} from "@/types";

/**
 * RequestBuilder - Main entry point
 *
 * Gets request ID from store, fetches data, and provides context
 */
export default function RequestBuilder() {
	const { openTabs, activeTabId, openTab, closeTab } = useTabsStore();
	const { activeEnvironmentId } = useSessionStore();
	const { startRun } = useDashboardStore();
	const showToast = useToastStore((s) => s.showToast);
	const { executeRequest: engineExecuteRequest } = useEngine();
	const updateRequestMutation = useUpdateRequestMutation();
	const queryClient = useQueryClient();

	// Get selectedRequestId from active tab
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const selectedRequestId = activeTab?.type === "request" ? activeTab.entityId : null;

	// Load test dialog state
	const [showLoadTestDialog, setShowLoadTestDialog] = useState(false);
	const [isStartingLoadTest, setIsStartingLoadTest] = useState(false);
	const [pendingLoadTestRequest, setPendingLoadTestRequest] = useState<RequestState | null>(null);

	// Fetch request data
	const {
		data: fetchedRequest,
		isLoading,
		isError,
		refetch,
	} = useRequestQuery(selectedRequestId);

	// Remember the collection the user is working in so the welcome screen can
	// land a new request here. Set from the loaded request, where collectionId
	// is authoritative - not from a tab-focus cache peek, which can be stale.
	const setLastCollectionId = useSessionStore((s) => s.setLastCollectionId);
	useEffect(() => {
		if (fetchedRequest?.collectionId) setLastCollectionId(fetchedRequest.collectionId);
	}, [fetchedRequest?.collectionId, setLastCollectionId]);

	// Ancestor chain for the current request's collection (root-first)
	const collectionAncestors = useCollectionAncestors(fetchedRequest?.collectionId);

	// Variable resolver for the current request's collection
	const { resolveString, resolveObject } = useVariableResolver({
		collectionId: fetchedRequest?.collectionId || undefined,
	});

	// Effective (variable-resolved) OAuth 2.0 config for the pending load-test
	// request, if its auth resolves to oauth2. Drives the token-expiry guard.
	const pendingOAuth2Config = useMemo<OAuth2Config | null>(() => {
		const req = pendingLoadTestRequest;
		if (!req) return null;
		let auth: RequestAuth | undefined;
		if (req.authType === "oauth2") {
			auth = editorToAuth("oauth2", req.authConfig);
		} else if (req.authType === "inherit") {
			for (let i = collectionAncestors.length - 1; i >= 0; i--) {
				if (collectionAncestors[i].auth.mode !== "none") {
					auth = collectionAncestors[i].auth;
					break;
				}
			}
		}
		if (!auth || auth.mode !== "oauth2") return null;
		return resolveObject(auth.config) as OAuth2Config;
	}, [pendingLoadTestRequest, collectionAncestors, resolveObject]);

	// Convert fetched request to RequestState format
	const initialRequest = useMemo((): Partial<RequestState> | undefined => {
		if (!fetchedRequest) return undefined;

		const body = fetchedRequest.body;
		const bodyMode =
			body.mode === "json"
				? "json"
				: body.mode === "form-data"
					? "form-data"
					: body.mode === "x-www-form-urlencoded"
						? "x-www-form-urlencoded"
						: body.mode === "text"
							? "text"
							: body.mode === "graphql"
								? "graphql"
								: "none";

		const rawBody = "content" in body ? body.content : "";
		const formFields = "fields" in body && body.mode === "form-data" ? body.fields : [];
		const urlEncodedFields =
			"fields" in body && body.mode === "x-www-form-urlencoded" ? body.fields : [];

		const auth = fetchedRequest.auth;
		// Map the domain auth (discriminated by mode) onto the flat editor state.
		const { authType, authConfig } = authToEditor(auth);

		return {
			id: fetchedRequest.id,
			name: fetchedRequest.name,
			description: fetchedRequest.description,
			method: fetchedRequest.method,
			url: fetchedRequest.url,
			params: toKeyValueItems(fetchedRequest.params),
			headers: toKeyValueItems(fetchedRequest.headers, true), // inject system headers
			bodyMode,
			body: rawBody,
			formData: toKeyValueItems(formFields),
			urlEncoded: toKeyValueItems(urlEncodedFields),
			authType,
			authConfig,
			preRequestScript: fetchedRequest.preRequestScript,
			testScript: fetchedRequest.postRequestScript,
			followRedirects: fetchedRequest.followRedirects,
			maxRedirects: fetchedRequest.maxRedirects,
			collectionId: fetchedRequest.collectionId,
		};
	}, [fetchedRequest]);

	// Execute request callback
	const handleExecute = useCallback(
		async (request: RequestState): Promise<ResponseState | null> => {
			if (!fetchedRequest) return null;

			try {
				// Resolve variables in URL, headers, and body before sending
				const resolvedUrl = resolveString(request.url);

				// Flatten enabled headers for execution; inject per-request system headers
				const headersRecord = toFlatHeaders(request.headers);
				headersRecord["X-Request-ID"] = generateUUID();
				const version =
					typeof __VAYU_VERSION__ !== "undefined" ? __VAYU_VERSION__ : "0.1.1";
				headersRecord["X-Vayu-Version"] = version;

				const resolvedHeaders = Object.fromEntries(
					Object.entries(headersRecord).map(([key, value]) => [
						resolveString(key),
						resolveString(value),
					])
				);
				// Shared with the History run view's send path - see execute-mapping.ts
				const execBody = buildExecBody(request, resolveString);

				// Resolve auth - walk collection chain for inherit, resolve variables for concrete
				let execAuth: Record<string, unknown> | undefined;
				if (request.authType === "inherit") {
					execAuth = resolveInheritedAuth(collectionAncestors);
					if (execAuth) execAuth = resolveObject(execAuth) as Record<string, unknown>;
				} else if (request.authType !== "none") {
					const concreteAuth = editorToAuth(
						request.authType,
						request.authConfig
					) as Exclude<RequestAuth, { mode: "inherit" }>;
					const raw = authToRecord(concreteAuth);
					execAuth = raw ? (resolveObject(raw) as Record<string, unknown>) : undefined;
				}

				// Script parts: the collection chain root to leaf, then the
				// request's own. The engine joins them and runs the result as
				// one script. Joining here meant a stored run could not say
				// which part came from where.
				const preScriptParts = scriptParts(
					collectionAncestors,
					(c) => c.preRequestScript,
					fetchedRequest.id,
					request.preRequestScript
				);
				const postScriptParts = scriptParts(
					collectionAncestors,
					(c) => c.postRequestScript,
					fetchedRequest.id,
					request.testScript
				);

				const result = await engineExecuteRequest(
					{
						method: request.method,
						url: resolvedUrl,
						headers: resolvedHeaders,
						body: execBody,
						auth: execAuth,
						preRequestScripts: preScriptParts,
						postRequestScripts: postScriptParts,
						// Always sent, never elided: the engine defaults to
						// following, so omitting `followRedirects: false` would
						// silently follow the redirect the user asked to see.
						followRedirects: request.followRedirects,
						maxRedirects: request.maxRedirects,
						requestId: fetchedRequest.id,
					},
					activeEnvironmentId || undefined
				);

				if (!result) return null;

				// Surface an OAuth 2.0 authorization requirement (the engine could
				// not fetch a token non-interactively) - the response still renders
				// its error, but the toast points the user at the fix.
				if (result.errorCode === "AUTH_REQUIRED") {
					showToast(
						"OAuth 2.0 token required - open the Auth tab and click Get Token",
						"error"
					);
				} else if (result.errorCode === "AUTH_FAILED") {
					showToast(result.errorMessage || "OAuth 2.0 token request failed", "error");
				}

				// Refresh variables so script-set values (e.g. pm.environment.set) appear in the UI
				if (preScriptParts) {
					queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
					queryClient.invalidateQueries({ queryKey: queryKeys.globals.all });
					queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
				}

				// Shared with the History run view's send path - see execute-mapping.ts
				return responseFromExecuteResult(result);
			} catch (error) {
				console.error("Execute request failed:", error);
				const errorMsg = error instanceof Error ? error.message : String(error);
				return {
					status: 0,
					statusText: "Error",
					headers: {},
					body: errorMsg,
					bodyType: "text",
					time: 0,
					size: 0,
					errorCode: "INTERNAL_ERROR",
					errorMessage: errorMsg,
				};
			}
		},
		[
			fetchedRequest,
			engineExecuteRequest,
			activeEnvironmentId,
			resolveString,
			resolveObject,
			queryClient,
			collectionAncestors,
		]
	);

	// Save request callback
	const handleSave = useCallback(
		async (request: RequestState) => {
			if (!fetchedRequest) return;

			// Build RequestBody discriminated union from flat UI state
			let bodyPayload: RequestBody;
			if (request.bodyMode === "form-data") {
				bodyPayload = { mode: "form-data", fields: toKeyValueEntries(request.formData) };
			} else if (request.bodyMode === "x-www-form-urlencoded") {
				bodyPayload = {
					mode: "x-www-form-urlencoded",
					fields: toKeyValueEntries(request.urlEncoded),
				};
			} else if (request.bodyMode !== "none" && request.body) {
				bodyPayload = {
					mode: request.bodyMode as "json" | "text" | "graphql",
					content: request.body,
				};
			} else {
				bodyPayload = { mode: "none" };
			}

			// Build RequestAuth from UI state
			const authPayload: RequestAuth = editorToAuth(request.authType, request.authConfig);

			await updateRequestMutation.mutateAsync({
				id: fetchedRequest.id,
				// `name` is deliberately omitted: the builder never edits it (it is
				// renamed from the collection sidebar), so `request.name` is only a
				// snapshot taken when the tab opened and the reset effect keeps it
				// keyed by id - a rename does not change the id, so the snapshot goes
				// stale. Sending it here made this debounced auto-save clobber a
				// sidebar rename with the old name a few seconds later. The engine
				// does a partial update on an existing id, so omitting `name` leaves
				// the current (renamed) value untouched.
				description: request.description,
				method: request.method as HttpMethod,
				url: request.url,
				params: toKeyValueEntries(request.params),
				headers: toKeyValueEntries(request.headers),
				body: bodyPayload,
				bodyType: bodyPayload.mode,
				auth: authPayload,
				preRequestScript: request.preRequestScript || undefined,
				postRequestScript: request.testScript || undefined,
				followRedirects: request.followRedirects,
				maxRedirects: request.maxRedirects,
			});
		},
		[fetchedRequest, updateRequestMutation]
	);

	// Start load test callback - shows the config dialog
	const handleStartLoadTest = useCallback(
		(request: RequestState) => {
			// Single-active-run policy: if one is already streaming, point the
			// user to it instead of starting another.
			if (useDashboardStore.getState().isStreaming) {
				openTab({ type: "dashboard", entityId: null });
				showToast("A load test is already running", "info");
				return;
			}
			setPendingLoadTestRequest(request);
			setShowLoadTestDialog(true);
		},
		[openTab, showToast]
	);

	// Actually start the load test with config
	const handleConfirmLoadTest = useCallback(
		async (config: LoadTestConfig) => {
			if (!pendingLoadTestRequest || !fetchedRequest) return;

			// Defensive re-check in case a run started while the dialog was open.
			if (useDashboardStore.getState().isStreaming) {
				openTab({ type: "dashboard", entityId: null });
				showToast("A load test is already running", "info");
				setShowLoadTestDialog(false);
				return;
			}

			setIsStartingLoadTest(true);
			try {
				// Resolve variables in URL, headers, and body before sending
				const resolvedUrl = resolveString(pendingLoadTestRequest.url);
				const resolvedHeaders = Object.fromEntries(
					Object.entries(toFlatHeaders(pendingLoadTestRequest.headers)).map(
						([key, value]) => [resolveString(key), resolveString(value)]
					)
				);
				const resolvedBody = pendingLoadTestRequest.body
					? resolveString(pendingLoadTestRequest.body)
					: pendingLoadTestRequest.body;

				// Build body payload matching the discriminated union
				let bodyPayload:
					| {
							mode: string;
							content?: string;
							fields?: Array<{ key: string; value: string; enabled: boolean }>;
					  }
					| undefined;
				if (pendingLoadTestRequest.bodyMode === "form-data") {
					bodyPayload = {
						mode: "form-data",
						fields: toKeyValueEntries(pendingLoadTestRequest.formData).map((e) => ({
							key: resolveString(e.key),
							value: resolveString(e.value),
							enabled: e.enabled,
						})),
					};
				} else if (pendingLoadTestRequest.bodyMode === "x-www-form-urlencoded") {
					bodyPayload = {
						mode: "x-www-form-urlencoded",
						fields: toKeyValueEntries(pendingLoadTestRequest.urlEncoded).map((e) => ({
							key: resolveString(e.key),
							value: resolveString(e.value),
							enabled: e.enabled,
						})),
					};
				} else if (resolvedBody) {
					bodyPayload = {
						mode: pendingLoadTestRequest.bodyMode || "text",
						content: resolvedBody,
					};
				}

				// Resolve auth for load test (same inherit logic as regular execute)
				let loadTestAuth: Record<string, unknown> | undefined;
				if (pendingLoadTestRequest.authType === "inherit") {
					loadTestAuth = resolveInheritedAuth(collectionAncestors);
					if (loadTestAuth)
						loadTestAuth = resolveObject(loadTestAuth) as Record<string, unknown>;
				} else if (pendingLoadTestRequest.authType !== "none") {
					const concreteAuth = editorToAuth(
						pendingLoadTestRequest.authType,
						pendingLoadTestRequest.authConfig
					) as Exclude<RequestAuth, { mode: "inherit" }>;
					const raw = authToRecord(concreteAuth);
					loadTestAuth = raw
						? (resolveObject(raw) as Record<string, unknown>)
						: undefined;
				}

				// Convert LoadTestConfig to StartLoadTestRequest (flat structure)
				const apiRequest: StartLoadTestRequest = {
					method: pendingLoadTestRequest.method,
					url: resolvedUrl,
					headers: resolvedHeaders,
					body: bodyPayload,
					auth: loadTestAuth,
					// Same redirect policy the single-request Send uses, so a
					// load test measures the same hops the user sees.
					followRedirects: pendingLoadTestRequest.followRedirects,
					maxRedirects: pendingLoadTestRequest.maxRedirects,
					// Load test config
					mode: config.mode,
					duration: config.duration_seconds ? `${config.duration_seconds}s` : undefined,
					targetRps: config.rps,
					iterations: config.iterations,
					concurrency: config.concurrency,
					rampUpDuration: config.ramp_duration_seconds
						? `${config.ramp_duration_seconds}s`
						: undefined,
					// Ramp-Up only. Never sent before: the field was plumbed to the
					// engine and read back into the dashboard, but nothing set it, so
					// every ramp started from the engine default of 1.
					startConcurrency: config.start_concurrency,
					maxInFlight: config.max_in_flight,
					requestId: fetchedRequest.id,
					environmentId: activeEnvironmentId || undefined,
					comment: config.comment,
					success_sample_rate: config.data_sample_rate,
					slow_threshold_ms: config.slow_threshold_ms,
					save_timing_breakdown: config.save_timing_breakdown,
					// The collection chain's test scripts too. Load runs only ever
					// validated the request's own, so a collection-level assertion
					// passed in design mode and was never checked under load.
					tests: scriptParts(
						collectionAncestors,
						(c) => c.postRequestScript,
						fetchedRequest.id,
						pendingLoadTestRequest.testScript
					),
				};

				const result = await apiService.startLoadTest(apiRequest);

				// Set the active run ID and switch to dashboard
				// Pass config and request info so dashboard can show them during live streaming
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
					},
					{
						method: apiRequest.method,
						url: apiRequest.url,
					},
					fetchedRequest.id
				);

				// Start global metrics monitoring (stays active even if user navigates away)
				loadTestService.startMonitoring(result.runId);

				openTab({ type: "dashboard", entityId: null });
				setShowLoadTestDialog(false);
				setPendingLoadTestRequest(null);
			} catch (error) {
				console.error("Failed to start load test:", error);
				showToast(
					error instanceof Error ? error.message : "Failed to start load test",
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
			resolveString,
			resolveObject,
			collectionAncestors,
		]
	);

	// Close load test dialog
	const handleCloseLoadTestDialog = useCallback(() => {
		setShowLoadTestDialog(false);
		setPendingLoadTestRequest(null);
	}, []);

	// Loading state
	if (!selectedRequestId) {
		return <EmptyState title="Select a request to get started" />;
	}

	if (isLoading) {
		return (
			<div className="flex-1 flex items-center justify-center">
				{/*
				 * Same ring as the response pane's loading state: `border-2` at
				 * `vayu-spin 0.7s`. This one was `border-4` at Tailwind's
				 * `animate-spin` (1s), so the two halves of the request builder
				 * showed visibly different spinners - a thicker ring turning more
				 * slowly on the left than on the right - whenever both were loading.
				 */}
				<div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-[vayu-spin_0.7s_linear_infinite]" />
			</div>
		);
	}

	/*
	 * Reaching here means the lookup errored. `useRequestQuery` hits
	 * `GET /requests/:id`, so a genuine deletion (404) is authoritative rather
	 * than the cold-start race it used to be; a transport failure lands here too,
	 * but the retry below recovers it once the engine is back. The message reads
	 * for the common case (deleted), and a centred "Request not found" with no
	 * way out used to leave the user to work out that closing the tab was the
	 * only move. Deleting a request already closes its tabs
	 * (`closeTabsForEntities`), so the usual cause is a delete from another
	 * window or a database restored underneath the app.
	 */
	if (isError || !fetchedRequest) {
		return (
			<ErrorState
				title="This request no longer exists"
				detail="It was deleted, or the collection it lived in was. Nothing here can be recovered - closing the tab is safe."
				onRetry={() => refetch()}
				action={
					activeTab ? (
						<Button variant="outline" size="sm" onClick={() => closeTab(activeTab.id)}>
							Close tab
						</Button>
					) : undefined
				}
			/>
		);
	}

	return (
		<>
			<RequestBuilderProvider
				initialRequest={initialRequest}
				collectionId={fetchedRequest.collectionId}
				onExecute={handleExecute}
				onSave={handleSave}
				onStartLoadTest={handleStartLoadTest}
			>
				<RequestBuilderLayout />
			</RequestBuilderProvider>

			{/* Load Test Configuration Dialog */}
			{showLoadTestDialog && (
				<LoadTestConfigDialog
					onClose={handleCloseLoadTestDialog}
					onStart={handleConfirmLoadTest}
					isStarting={isStartingLoadTest}
					hasPreRequestScript={!!pendingLoadTestRequest?.preRequestScript?.trim()}
					oauth2Config={pendingOAuth2Config ?? undefined}
				/>
			)}
		</>
	);
}

// Re-export types and context for external use
export { useRequestBuilderContext } from "./context";
export type { RequestState, ResponseState, KeyValueItem } from "./types";
