
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

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RequestBuilderProvider } from "./context";
import RequestBuilderLayout from "./components/RequestBuilderLayout";
import LoadTestConfigDialog from "./components/LoadTestConfigDialog";
import { useNavigationStore, useVariablesStore, useDashboardStore } from "@/stores";
import { useRequestQuery, useUpdateRequestMutation, queryKeys } from "@/queries";
import { useEngine, useVariableResolver } from "@/hooks";
import { apiService, loadTestService } from "@/services";
import type { RequestState, ResponseState } from "./types";
import { toKeyValueItems, toKeyValueEntries, toFlatHeaders } from "./utils/key-value";
import { generateUUID } from "./utils/id";
import type { HttpMethod, LoadTestConfig, StartLoadTestRequest, RequestBody, RequestAuth } from "@/types";

/**
 * RequestBuilder - Main entry point
 *
 * Gets request ID from store, fetches data, and provides context
 */
export default function RequestBuilder() {
	const { selectedRequestId } = useNavigationStore();
	const { navigateToDashboard } = useNavigationStore();
	const { activeEnvironmentId } = useVariablesStore();
	const { startRun } = useDashboardStore();
	const { executeRequest: engineExecuteRequest } = useEngine();
	const updateRequestMutation = useUpdateRequestMutation();
	const queryClient = useQueryClient();

	// Load test dialog state
	const [showLoadTestDialog, setShowLoadTestDialog] = useState(false);
	const [isStartingLoadTest, setIsStartingLoadTest] = useState(false);
	const [pendingLoadTestRequest, setPendingLoadTestRequest] = useState<RequestState | null>(null);

	// Fetch request data
	const { data: fetchedRequest, isLoading } = useRequestQuery(selectedRequestId);

	// Variable resolver for the current request's collection
	const { resolveString, resolveObject } = useVariableResolver({
		collectionId: fetchedRequest?.collectionId || undefined,
	});

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
								? "text"
								: "none";

		const rawBody = "content" in body ? body.content : "";
		const formFields = "fields" in body && body.mode === "form-data" ? body.fields : [];
		const urlEncodedFields =
			"fields" in body && body.mode === "x-www-form-urlencoded" ? body.fields : [];

		const auth = fetchedRequest.auth;
		const authType =
			auth.mode === "bearer"
				? "bearer"
				: auth.mode === "basic"
					? "basic"
					: auth.mode === "apikey"
						? "api-key"
						: auth.mode === "inherit"
							? "inherit"
							: "none";
		const authConfig: Record<string, any> =
			auth.mode !== "none" && auth.mode !== "inherit" ? (auth as any) : {};

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
				const resolvedBody = request.body ? resolveString(request.body) : request.body;

				// Build body payload for engine: {mode, content}
				const execBody =
					request.bodyMode !== "none" && resolvedBody
						? { mode: request.bodyMode || "text", content: resolvedBody }
						: undefined;

				// Build resolved auth for engine (exclude inherit — engine needs concrete auth)
				const execAuth =
					request.authType !== "none" && request.authType !== "inherit"
						? resolveObject(request.authConfig)
						: undefined;

				const result = await engineExecuteRequest(
					{
						method: request.method,
						url: resolvedUrl,
						headers: resolvedHeaders,
						body: execBody,
						auth: execAuth as Record<string, unknown> | undefined,
						preRequestScript: request.preRequestScript || undefined,
						postRequestScript: request.testScript || undefined,
						requestId: fetchedRequest.id,
					},
					activeEnvironmentId || undefined
				);

				if (!result) return null;

				// Refresh variables so script-set values (e.g. pm.environment.set) appear in the UI
				if (request.preRequestScript.trim()) {
					queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
					queryClient.invalidateQueries({ queryKey: queryKeys.globals.all });
					queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
				}

				// Determine body type from content-type header
				const contentType = (result.headers?.["content-type"] || "").toLowerCase();
				const bodyType: ResponseState["bodyType"] = contentType.includes("json")
					? "json"
					: contentType.includes("html")
						? "html"
						: contentType.includes("xml")
							? "xml"
							: "text";

				// Extract bodyRaw (raw response from server) - always use this for raw view
				const bodyRaw = result.bodyRaw ||
					(typeof result.body === "object" && result.body !== null
						? JSON.stringify(result.body, null, 2)
						: String(result.body || ""));

				// For pretty view, use parsed body if available, otherwise use raw
				// Note: typeof null === "object" in JavaScript, so we need to check for null explicitly
				const body = typeof result.body === "object" && result.body !== null
					? JSON.stringify(result.body, null, 2)
					: result.body !== null && result.body !== undefined
						? String(result.body)
						: bodyRaw || "";

				return {
					// Use status from result, but don't default to 200 if it's 0 (client-side error)
					// 0 is a valid status code for client-side errors (no server response)
					status: result.status !== undefined && result.status !== null ? result.status : 200,
					statusText: result.statusText || (result.status === 0 ? "Error" : result.status >= 400 ? "Error" : "OK"),
					headers: result.headers || {},
					requestHeaders: result.requestHeaders,
					rawRequest: result.rawRequest,
					body,
					bodyRaw,  // Always include raw body for raw view mode
					bodyType,
					time: result.timing?.total || 0,
					size: result.bodySize || 0,
					// Client-side error info (from engine/curl)
					errorCode: result.errorCode,
					errorMessage: result.errorMessage,
					// Script execution results
					consoleLogs: result.consoleLogs,
					testResults: result.testResults,
					preScriptError: result.preScriptError,
					postScriptError: result.postScriptError,
				};
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
		[fetchedRequest, engineExecuteRequest, activeEnvironmentId, resolveString, resolveObject, queryClient]
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
			bodyPayload = { mode: "x-www-form-urlencoded", fields: toKeyValueEntries(request.urlEncoded) };
		} else if (request.bodyMode !== "none" && request.body) {
			bodyPayload = { mode: request.bodyMode as "json" | "text" | "graphql", content: request.body };
		} else {
			bodyPayload = { mode: "none" };
		}

		// Build RequestAuth from UI state
		let authPayload: RequestAuth;
		if (request.authType === "bearer") {
			authPayload = { mode: "bearer", token: request.authConfig.token ?? "" };
		} else if (request.authType === "basic") {
			authPayload = { mode: "basic", username: request.authConfig.username ?? "", password: request.authConfig.password ?? "" };
		} else if (request.authType === "api-key") {
			authPayload = { mode: "apikey", key: request.authConfig.key ?? "", value: request.authConfig.value ?? "", in: request.authConfig.addTo ?? "header" };
		} else if (request.authType === "inherit") {
			authPayload = { mode: "inherit" };
		} else {
			authPayload = { mode: "none" };
		}

		await updateRequestMutation.mutateAsync({
				id: fetchedRequest.id,
				name: request.name,
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
			});
		},
		[fetchedRequest, updateRequestMutation]
	);

	// Start load test callback - shows the config dialog
	const handleStartLoadTest = useCallback((request: RequestState) => {
		setPendingLoadTestRequest(request);
		setShowLoadTestDialog(true);
	}, []);

	// Actually start the load test with config
	const handleConfirmLoadTest = useCallback(
		async (config: LoadTestConfig) => {
			if (!pendingLoadTestRequest || !fetchedRequest) return;

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

				// Build body in the format backend expects: { mode, content }
				const bodyPayload = resolvedBody
					? {
						mode: pendingLoadTestRequest.bodyMode || "text",
						content: resolvedBody,
					}
					: undefined;

				// Convert LoadTestConfig to StartLoadTestRequest (flat structure)
				const apiRequest: StartLoadTestRequest = {
					method: pendingLoadTestRequest.method,
					url: resolvedUrl,
					headers: resolvedHeaders,
					body: bodyPayload,
					// Load test config
					mode: config.mode,
					duration: config.duration_seconds ? `${config.duration_seconds}s` : undefined,
					targetRps: config.rps,
					iterations: config.iterations,
					concurrency: config.concurrency,
					rampUpDuration: config.ramp_duration_seconds
						? `${config.ramp_duration_seconds}s`
						: undefined,
					requestId: fetchedRequest.id,
					environmentId: activeEnvironmentId || undefined,
					comment: config.comment,
					success_sample_rate: config.data_sample_rate,
					slow_threshold_ms: config.slow_threshold_ms,
					save_timing_breakdown: config.save_timing_breakdown,
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
					},
					{
						method: apiRequest.method,
						url: apiRequest.url,
					}
				);

				// Start global metrics monitoring (stays active even if user navigates away)
				loadTestService.startMonitoring(result.runId);

				navigateToDashboard();
				setShowLoadTestDialog(false);
				setPendingLoadTestRequest(null);
			} catch (error) {
				console.error("Failed to start load test:", error);
				// TODO: Show error toast
			} finally {
				setIsStartingLoadTest(false);
			}
		},
		[
			pendingLoadTestRequest,
			fetchedRequest,
			activeEnvironmentId,
			startRun,
			navigateToDashboard,
			resolveString,
		]
	);

	// Close load test dialog
	const handleCloseLoadTestDialog = useCallback(() => {
		setShowLoadTestDialog(false);
		setPendingLoadTestRequest(null);
	}, []);

	// Loading state
	if (!selectedRequestId) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground">
				<p>Select a request to get started</p>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
			</div>
		);
	}

	if (!fetchedRequest) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground">
				<p>Request not found</p>
			</div>
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
				/>
			)}
		</>
	);
}

// Re-export types and context for external use
export { useRequestBuilderContext } from "./context";
export type { RequestState, ResponseState, KeyValueItem } from "./types";
