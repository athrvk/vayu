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
import LoadTestCommandSurface from "./components/LoadTestCommandSurface";
import SendRequestCommandSurface from "./components/SendRequestCommandSurface";
import { useTabsStore, useSessionStore, useDashboardStore, useToastStore } from "@/stores";
import {
	useRequestQuery,
	isRequestNotFound,
	useUpdateRequestMutation,
	useCollectionAncestors,
	queryKeys,
} from "@/queries";
import { EmptyState, ErrorState } from "@/components/shared";
import { Button } from "@/components/ui";
import { useEngine, useVariableResolver } from "@/hooks";
import { humanizeOAuth2Error } from "@/constants/oauth2-fields";
import { apiService, loadTestService } from "@/services";
import type { RequestState, ResponseState, StreamStartResult } from "./types";
import { resolveAuthSource } from "./utils/auth-resolution";
import { toKeyValueItems, toKeyValueEntries } from "@/components/shared/KeyValueEditor/key-value";
import { toHeaderItems } from "./utils/system-headers";
import { toFlatHeaders } from "./utils/key-value";
import { scriptParts } from "./utils/script-parts";
import {
	buildExecBody,
	disabledDefaults,
	execIdentity,
	responseFromExecuteResult,
	scriptsMayWriteVariables,
} from "./utils/execute-mapping";
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
	const { executeRequest: engineExecuteRequest, composeRequest: engineComposeRequest } =
		useEngine();
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
		error: requestLookupError,
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
	// Preview-only since #226: execution resolves engine-side (POST /compose).
	// `resolveObject` still backs the load dialog's OAuth token-expiry guard,
	// which previews the effective config without sending anything.
	const { resolveObject } = useVariableResolver({
		collectionId: fetchedRequest?.collectionId || undefined,
	});

	// Effective (variable-resolved) OAuth 2.0 config for the pending load-test
	// request, if its auth resolves to oauth2. Drives the token-expiry guard.
	const pendingOAuth2Config = useMemo<OAuth2Config | null>(() => {
		const req = pendingLoadTestRequest;
		if (!req) return null;
		let auth: RequestAuth | undefined;
		if (req.auth.mode === "oauth2") {
			auth = req.auth;
		} else if (req.auth.mode === "inherit") {
			// Shared walk, so an ancestor set to No Auth stops the search here too -
			// otherwise the guard would fetch a token the request never sends.
			auth = resolveAuthSource(collectionAncestors).source?.auth;
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
								: body.mode === "jsonrpc"
									? "jsonrpc"
									: body.mode === "xml"
										? "xml"
										: "none";

		const rawBody = "content" in body ? body.content : "";
		const formFields = "fields" in body && body.mode === "form-data" ? body.fields : [];
		const urlEncodedFields =
			"fields" in body && body.mode === "x-www-form-urlencoded" ? body.fields : [];

		return {
			id: fetchedRequest.id,
			name: fetchedRequest.name,
			description: fetchedRequest.description,
			method: fetchedRequest.method,
			url: fetchedRequest.url,
			params: toKeyValueItems(fetchedRequest.params),
			headers: toHeaderItems(fetchedRequest.headers),
			bodyMode,
			body: rawBody,
			formData: toKeyValueItems(formFields),
			urlEncoded: toKeyValueItems(urlEncodedFields),
			auth: fetchedRequest.auth,
			// `?? ""` rather than the bare field: these are optional on the
			// wire type, and spreading an explicit `undefined` over
			// `createDefaultRequestState()` would replace the `""` default with
			// it. The save payload below sends both verbatim, so a state that
			// held `undefined` would drop the key and lose a clear.
			preRequestScript: fetchedRequest.preRequestScript ?? "",
			testScript: fetchedRequest.postRequestScript ?? "",
			followRedirects: fetchedRequest.followRedirects,
			maxRedirects: fetchedRequest.maxRedirects,
			httpVersion: fetchedRequest.httpVersion,
			verifySSL: fetchedRequest.verifySSL,
			stream: fetchedRequest.stream,
			collectionId: fetchedRequest.collectionId,
		};
	}, [fetchedRequest]);

	/**
	 * The composed payload a Send puts on the wire, and the script parts that
	 * went into it.
	 *
	 * Shared by the buffered and the streaming send (issue #574): the two differ
	 * only in which endpoint answer they take, and everything up to that point -
	 * the headers, the body builder, the collection chain's scripts, the
	 * engine-side composition - has to be identical, or a stream would measure a
	 * different request from the one Send sends.
	 *
	 * `collectionAncestors` is the live chain, so a stream's refusal for
	 * carrying scripts is decided by what the send *would* run, not by what this
	 * request alone declares.
	 *
	 * `dataRow` is Send-with-row's chosen row (issue #601), and composition needs
	 * it for its *names* alone - see the `dataColumns` field below.
	 */
	const composeForSend = useCallback(
		async (
			request: RequestState,
			ownerId: string,
			ownerCollectionId: string,
			dataRow?: Record<string, unknown>
		) => {
			// The user's enabled headers, flattened for execution - and nothing
			// else. What Vayu adds is the engine's since issue #1229, applied on
			// every send path rather than by whichever client happened to send.
			const headersRecord = toFlatHeaders(request.headers);

			// Shared with the History run view's send path - see execute-mapping.ts.
			// Raw: since #226 the engine resolves {{variables}} and inherit auth
			// (POST /compose), so the editor state goes over as-is - resolving
			// here too would interpolate the payload twice.
			const execBody = buildExecBody(request, (s) => s);

			// Script parts: the collection chain root to leaf, then the
			// request's own. The engine joins them and runs the result as
			// one script. Joining here meant a stored run could not say
			// which part came from where.
			const preScriptParts = scriptParts(
				collectionAncestors,
				(c) => c.preRequestScript,
				ownerId,
				request.preRequestScript
			);
			const postScriptParts = scriptParts(
				collectionAncestors,
				(c) => c.postRequestScript,
				ownerId,
				request.testScript
			);

			// Compose engine-side, then execute the composed payload unchanged.
			// The inline shape (not compose-by-id) is deliberate: Send executes
			// the *editor state*, which may be ahead of the saved row.
			const composed = await engineComposeRequest({
				request: {
					method: request.method,
					url: request.url,
					headers: headersRecord,
					body: execBody,
					auth: { ...request.auth },
					preRequestScripts: preScriptParts,
					postRequestScripts: postScriptParts,
					// Always sent, never elided: the engine defaults to
					// following, so omitting `followRedirects: false` would
					// silently follow the redirect the user asked to see.
					followRedirects: request.followRedirects,
					maxRedirects: request.maxRedirects,
					// Same rule, same reason: an omitted httpVersion lets the
					// engine's own default win silently, which is not a
					// decision this client should hand over.
					httpVersion: request.httpVersion,
					// And the one where the silent default is a security
					// decision: `verify_ssl` defaults to true engine-side, so an
					// omitted `false` verifies the certificate the user turned
					// verification off for (issue #706).
					verifySSL: request.verifySSL,
					// Identity for the script sandbox (pm.info), not an HTTP
					// field - it rides through composition to /execute.
					...execIdentity(request),
				},
				collectionId: ownerCollectionId,
				environmentId: activeEnvironmentId || undefined,
				// The row's own keys, which is exactly the set the engine's bind
				// reads back (issue #1007). A Postman-shaped `{{username}}` has to
				// survive composition to reach that bind, so composition is told the
				// names *before* it can answer one of them from a same-named
				// environment variable. Names only: a value here would be this row's
				// value written into a payload composed once. Absent for an ordinary
				// Send, which composes exactly as it did.
				...(dataRow ? { dataColumns: Object.keys(dataRow) } : {}),
			});

			return { composed, preScriptParts, postScriptParts };
		},
		[collectionAncestors, engineComposeRequest, activeEnvironmentId]
	);

	// Execute request callback
	const handleExecute = useCallback(
		async (
			request: RequestState,
			dataRow?: Record<string, unknown>
		): Promise<ResponseState | null> => {
			if (!fetchedRequest) return null;

			try {
				const { composed, preScriptParts, postScriptParts } = await composeForSend(
					request,
					fetchedRequest.id,
					fetchedRequest.collectionId,
					dataRow
				);

				const result = await engineExecuteRequest(
					// `stream: false` explicitly, never elided - the two answers
					// this endpoint can give are different *shapes*, so which one
					// is coming back is not a decision to hand to an engine-side
					// default. See `ExecuteRequestRequest.stream`.
					{
						...composed,
						requestId: fetchedRequest.id,
						stream: false,
						// The defaults this send refuses (issue #1229). Beside the
						// composed payload rather than through composition: what
						// the engine adds is decided at send time from config, so
						// the opt-out belongs to the send, not to the composed
						// request. Omitted entirely when nothing is switched off.
						...disabledDefaults(request),
						// A Send-with-row's row, or nothing at all (issue #601).
						// It rides *beside* the composed payload rather than
						// through composition: `{{data.*}}` survives compose by
						// design, so the tokens are still written when the
						// engine binds them here.
						...(dataRow ? { data: dataRow } : {}),
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
					// The engine's message names JSON fields (accessTokenUrl); the user
					// is looking at a form that labels them (Access Token URL).
					showToast(
						result.errorMessage
							? humanizeOAuth2Error(result.errorMessage)
							: "OAuth 2.0 token request failed",
						"error"
					);
				}

				// This send is a new design run, and the context bar's Recent
				// sends list is not polled - without this it would keep showing
				// the sends from before this one for as long as the tab is open.
				// The history list has its own 5s poll and needs nothing here.
				queryClient.invalidateQueries({
					queryKey: queryKeys.runs.recentDesign(fetchedRequest.id),
				});

				// Refresh variables so script-set values (e.g. pm.environment.set)
				// appear in the UI - post-request scripts write them too, see the
				// helper's note.
				if (scriptsMayWriteVariables(preScriptParts, postScriptParts)) {
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
			composeForSend,
			engineExecuteRequest,
			activeEnvironmentId,
			queryClient,
			showToast,
		]
	);

	/**
	 * Start a stream-flagged send (issue #574).
	 *
	 * The composition is the buffered path's, exactly; only the answer differs -
	 * `202 {runId, eventsUrl}` and no exchange, because there is none yet. The
	 * provider takes it from here: it registers the stream and the events hook
	 * tails it.
	 *
	 * A refusal comes back as a response to render rather than as a thrown
	 * error swallowed at the boundary. The engine's refusals here are ones a
	 * user has to read and act on - a stream cannot carry scripts, and the
	 * scripts a send carries include the collection chain's - so the message is
	 * shown in the pane where the response would have been, and repeated as a
	 * toast because the pane is easy to miss when the Events tab is the one on
	 * screen.
	 */
	const handleExecuteStream = useCallback(
		async (
			request: RequestState,
			dataRow?: Record<string, unknown>
		): Promise<StreamStartResult | null> => {
			if (!fetchedRequest) return null;

			try {
				const { composed } = await composeForSend(
					request,
					fetchedRequest.id,
					fetchedRequest.collectionId,
					dataRow
				);

				const started = await apiService.executeStreamRequest({
					...composed,
					requestId: fetchedRequest.id,
					environmentId: activeEnvironmentId || undefined,
					// Same opt-out the buffered send carries - a stream must not
					// go out with a header set the buffered send would not.
					...disabledDefaults(request),
					// A stream binds a row exactly as a buffered send does - the
					// engine reads it before the transfer starts, so the URL and
					// headers it opens with are the bound ones (issue #601).
					...(dataRow ? { data: dataRow } : {}),
				});

				// A stream is a design run like any other, so the context bar's
				// Recent sends list has to hear about it now - it is not polled,
				// and the run exists from this moment rather than when the stream
				// ends.
				queryClient.invalidateQueries({
					queryKey: queryKeys.runs.recentDesign(fetchedRequest.id),
				});

				return { ok: true, runId: started.runId, eventsUrl: started.eventsUrl };
			} catch (error) {
				console.error("Stream request failed:", error);
				const errorMsg = error instanceof Error ? error.message : String(error);
				showToast(errorMsg, "error");
				return {
					ok: false,
					response: {
						status: 0,
						statusText: "Error",
						headers: {},
						body: errorMsg,
						bodyType: "text",
						time: 0,
						size: 0,
						errorCode: "INTERNAL_ERROR",
						errorMessage: errorMsg,
					},
				};
			}
		},
		[fetchedRequest, composeForSend, activeEnvironmentId, queryClient, showToast]
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
					mode: request.bodyMode as "json" | "text" | "graphql" | "jsonrpc" | "xml",
					content: request.body,
				};
			} else {
				bodyPayload = { mode: "none" };
			}

			const authPayload: RequestAuth = request.auth;

			/*
			 * A blank name is refused rather than saved.
			 *
			 * The Info tab restores the stored name on blur and says so, but the
			 * debounced auto-save can fire while the field is still empty and
			 * focused - so the guard has to be here too, where every save path
			 * passes. Omitting the key leaves the stored name untouched (the
			 * engine does a partial update on an existing id); sending `""` would
			 * make a request nameless everywhere it is listed.
			 *
			 * `name` was omitted unconditionally until the Info tab gained a name
			 * field. The reason was staleness, not ownership: the builder's copy
			 * was a snapshot taken when the tab opened, so an auto-save fired
			 * minutes after a sidebar rename carried the pre-rename name and
			 * clobbered it. The provider now adopts a name that changes
			 * underneath it, so the copy sent here is never stale.
			 */
			const name = request.name.trim();

			await updateRequestMutation.mutateAsync({
				id: fetchedRequest.id,
				...(name ? { name } : {}),
				description: request.description,
				method: request.method as HttpMethod,
				url: request.url,
				params: toKeyValueEntries(request.params),
				// Only the user's rows: nothing in editor state is Vayu's own any
				// more (issue #1229), so this needs no filter to stay clean.
				// `disabledDefaultHeaders` is deliberately absent - none of the
				// opt-outs is persisted; they belong to a send, and the defaults
				// they refuse are re-resolved from engine config on every one.
				headers: toKeyValueEntries(request.headers),
				body: bodyPayload,
				bodyType: bodyPayload.mode,
				auth: authPayload,
				/*
				 * Both scripts are sent as they are, empty string included.
				 *
				 * They used to be `|| undefined`, the only two fields in this
				 * payload that were. `undefined` serialises the key out of the
				 * body, and an absent key on a `PUT` means "leave the stored
				 * value alone" (`apply_string_field` in the engine's routes) -
				 * so deleting a whole script saved nothing while the Dock
				 * reported "Saved", and the old script came back on the next
				 * open. `""` is a value the engine stores, which is what
				 * clearing a script means. Both fields are always strings here:
				 * `createDefaultRequestState` seeds them `""` and the memo above
				 * keeps them strings.
				 */
				preRequestScript: request.preRequestScript,
				postRequestScript: request.testScript,
				followRedirects: request.followRedirects,
				maxRedirects: request.maxRedirects,
				httpVersion: request.httpVersion,
				verifySSL: request.verifySSL,
				stream: request.stream,
			});
		},
		[fetchedRequest, updateRequestMutation]
	);

	// Start load test callback - shows the config dialog
	const handleStartLoadTest = useCallback(
		(request: RequestState) => {
			/*
			 * Single-active-run policy: if one is already streaming, point the
			 * user to it instead of starting another.
			 *
			 * This gate is about *load* runs only. A streaming design request
			 * (issue #574) is not checked here and deliberately does not block
			 * one: they are independent surfaces - a design stream holds one
			 * consumer on one run's events and reports into the response pane,
			 * while a load run owns the dashboard - and neither can be mistaken
			 * for the other or read the other's numbers.
			 */
			if (useDashboardStore.getState().isStreaming) {
				openTab({ type: "dashboard", entityId: null });
				showToast("A load test is already running", "warning");
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
				showToast("A load test is already running", "warning");
				setShowLoadTestDialog(false);
				return;
			}

			setIsStartingLoadTest(true);
			try {
				// The raw request half - the engine resolves {{variables}} and
				// inherit auth when it composes (POST /compose, issue #226).
				// `buildExecBody` is the same builder Send uses; sharing it is what
				// keeps a load test measuring the request Send sends.
				const bodyPayload = buildExecBody(pendingLoadTestRequest, (s) => s);

				// Compose engine-side, then start the run with the composed
				// request half plus the load shape - never re-resolved.
				const composed = await engineComposeRequest({
					request: {
						method: pendingLoadTestRequest.method,
						url: pendingLoadTestRequest.url,
						headers: toFlatHeaders(pendingLoadTestRequest.headers),
						body: bodyPayload,
						auth: { ...pendingLoadTestRequest.auth },
						// Same redirect policy the single-request Send uses, so a
						// load test measures the same hops the user sees.
						followRedirects: pendingLoadTestRequest.followRedirects,
						maxRedirects: pendingLoadTestRequest.maxRedirects,
						// Same protocol the single-request Send uses, and always
						// sent for the same reason - see the execute payload above.
						// One control in the Settings tab governs both modes; the
						// load dialog decides load shape, not request semantics.
						httpVersion: pendingLoadTestRequest.httpVersion,
						// And its TLS verification, for the same reason: a load
						// test that verified where Send did not would fail on
						// every request against the host the user opted out for.
						verifySSL: pendingLoadTestRequest.verifySSL,
						// The collection chain's test scripts too. Load runs only ever
						// validated the request's own, so a collection-level assertion
						// passed in design mode and was never checked under load.
						// Scripts ride through composition untouched - the engine
						// never interpolates script text.
						tests: scriptParts(
							collectionAncestors,
							(c) => c.postRequestScript,
							fetchedRequest.id,
							pendingLoadTestRequest.testScript
						),
					},
					collectionId: fetchedRequest.collectionId,
					environmentId: activeEnvironmentId || undefined,
					// The picked file's columns, when the dialog picked one (issue
					// #1007). This composition happens *before* `POST /runs`, so it is
					// the only place that can leave a bare `{{username}}` for the
					// per-iteration bind instead of resolving it from the environment.
					// Names only, and absent whenever `config.data` is - a run with no
					// data set composes exactly as it did.
					...(config.dataColumns ? { dataColumns: config.dataColumns } : {}),
					// This composed payload is repeated once per iteration, per
					// virtual user, so the `{{$guid}}` family belongs to each
					// repetition, not to the one-time composition - leave the tokens
					// written as-is and let the engine generate a fresh value per
					// iteration at bind time (issue #995).
					deferDynamicVariables: true,
				});

				// Convert LoadTestConfig to StartLoadTestRequest (flat structure)
				const apiRequest: StartLoadTestRequest = {
					...(composed as unknown as StartLoadTestRequest),
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
					// Capacity only. `startConcurrency` above is where the search
					// begins and `concurrency` is its ceiling, so the mode adds
					// only these two rather than a second spelling of bounds the
					// ramp already owns.
					sloMs: config.slo_ms,
					stepDuration: config.step_duration_seconds
						? `${config.step_duration_seconds}s`
						: undefined,
					maxInFlight: config.max_in_flight,
					// A load run of a streaming request streams (issue #576).
					// Read off the request rather than the dialog, and sent as
					// `false` rather than elided when it does not, for the same
					// reason the execute payload spells it out: the engine's
					// composed payload may carry a stale flag, and an omitted
					// `false` would be read as "unset", not as "no".
					stream: pendingLoadTestRequest.stream ?? false,
					// The caps, in the engine's milliseconds. Present only for a
					// streaming run - the engine rejects a cap without `stream`,
					// which is what stops an unbounded run from being mistaken
					// for a capped one.
					maxStreamDurationMs: config.stream_duration_seconds
						? config.stream_duration_seconds * 1000
						: undefined,
					maxStreamEvents: config.stream_max_events,
					requestId: fetchedRequest.id,
					environmentId: activeEnvironmentId || undefined,
					comment: config.comment,
					success_sample_rate: config.success_sample_period,
					slow_threshold_ms: config.slow_threshold_ms,
					save_timing_breakdown: config.save_timing_breakdown,
					// Undefined when the dialog declared no budgets: the engine
					// rejects an empty `thresholds` object rather than starting a
					// run whose verdict nothing can compute.
					thresholds: config.thresholds,
					// Undefined when the dialog named no metrics endpoint, for the
					// same reason - and a run without it behaves exactly as it did
					// before server monitoring existed.
					monitor: config.monitor,
					// The rows the dialog's file picker parsed (issue #993), which
					// the engine binds one per submission. Undefined when no file
					// was picked: a present-but-empty array is refused engine-side,
					// so "no data set" has to be the absent key rather than `[]`.
					data: config.data,
					// The engine defaults this run refuses (issue #1229). A load
					// run has to send the header set Send sends, or it measures a
					// different request from the one the user tried.
					...disabledDefaults(pendingLoadTestRequest),
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
			engineComposeRequest,
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
	 * Reaching here means the lookup errored, and the two reasons need different
	 * panes. `useRequestQuery` hits `GET /requests/:id`, so a genuine deletion
	 * throws the `RequestNotFoundError` sentinel and is authoritative - telling
	 * the user their request is gone is correct, and offering a retry is not,
	 * since a 404 can only 404 again. Every other failure (a 5xx, an engine that
	 * is not up yet) means the request is very probably still there and only the
	 * lookup failed; saying "no longer exists" there is a lie that invites the
	 * user to close a tab they will want back. Discriminated by type, never by
	 * message - same rule as `DesignRunView`.
	 *
	 * Deleting a request already closes its tabs (`closeTabsForEntities`), so the
	 * usual cause of the deleted branch is a delete from another window or a
	 * database restored underneath the app.
	 */
	const requestWasDeleted =
		isRequestNotFound(requestLookupError) || (!isError && !fetchedRequest);
	if (isError || !fetchedRequest) {
		const closeTabAction = activeTab ? (
			<Button variant="outline" size="sm" onClick={() => closeTab(activeTab.id)}>
				Close tab
			</Button>
		) : undefined;

		return requestWasDeleted ? (
			<ErrorState
				title="This request no longer exists"
				detail="It was deleted, or the collection it lived in was. Nothing here can be recovered - closing the tab is safe."
				action={closeTabAction}
			/>
		) : (
			<ErrorState
				title="Couldn't load this request"
				detail="The engine could not be reached, or it failed to answer. The request itself is probably fine."
				onRetry={() => refetch()}
				action={closeTabAction}
			/>
		);
	}

	return (
		<>
			<RequestBuilderProvider
				initialRequest={initialRequest}
				collectionId={fetchedRequest.collectionId}
				onExecute={handleExecute}
				onExecuteStream={handleExecuteStream}
				onSave={handleSave}
				onStartLoadTest={handleStartLoadTest}
			>
				<RequestBuilderLayout />
				{/* Render nothing. They publish this builder's live draft to the
				    command registry, so the palette's "Load test …" and "Send …"
				    act on the request as currently edited rather than as last
				    saved. */}
				<LoadTestCommandSurface />
				<SendRequestCommandSurface />
			</RequestBuilderProvider>

			{/* Load Test Configuration Dialog */}
			{showLoadTestDialog && (
				<LoadTestConfigDialog
					onClose={handleCloseLoadTestDialog}
					onStart={handleConfirmLoadTest}
					isStarting={isStartingLoadTest}
					hasPreRequestScript={!!pendingLoadTestRequest?.preRequestScript?.trim()}
					oauth2Config={pendingOAuth2Config ?? undefined}
					isStreamingRequest={!!pendingLoadTestRequest?.stream}
					collectionId={fetchedRequest?.collectionId}
				/>
			)}
		</>
	);
}

// Re-export types for external use. The context hook is not re-exported here:
// every consumer imports it from `./context` directly, and a value export
// alongside the component would cost this file its fast refresh.
export type { RequestState, ResponseState } from "./types";
