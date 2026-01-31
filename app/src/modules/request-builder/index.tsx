
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
import { recordToKeyValue, keyValueToRecord } from "./utils/key-value";
import { generateUUID } from "./utils/id";
import type { Request, HttpMethod, LoadTestConfig, StartLoadTestRequest } from "@/types";

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

		return {
			id: fetchedRequest.id,
			name: fetchedRequest.name,
			method: fetchedRequest.method,
			url: fetchedRequest.url,
			params: recordToKeyValue(fetchedRequest.params || {}, false), // No system headers for params
			headers: recordToKeyValue(fetchedRequest.headers || {}, true), // System headers only for headers
			bodyMode:
				fetchedRequest.bodyType === "json"
					? "json"
					: fetchedRequest.bodyType === "form-data"
						? "form-data"
						: fetchedRequest.bodyType === "x-www-form-urlencoded"
							? "x-www-form-urlencoded"
							: fetchedRequest.bodyType === "text"
								? "text"
								: "none",
			body: fetchedRequest.body || "",
			formData: [],
			urlEncoded: [],
			authType:
				fetchedRequest.auth?.type === "bearer"
					? "bearer"
					: fetchedRequest.auth?.type === "basic"
						? "basic"
						: fetchedRequest.auth?.type === "api_key"
							? "api-key"
							: "none",
			authConfig: fetchedRequest.auth || {},
			preRequestScript: fetchedRequest.preRequestScript || "",
			testScript: fetchedRequest.postRequestScript || "",
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

				// Regenerate UUID for X-Request-ID header on each execution
				// Also ensure version header is always from package.json (protected)
				const headersRecord = keyValueToRecord(request.headers);
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

				// Resolve auth config if present
				const resolvedAuthConfig =
					request.authType !== "none" && request.authConfig
						? resolveObject(request.authConfig)
						: request.authConfig;

				// Convert RequestState back to Request format for the engine
				const engineRequest: Request = {
					...fetchedRequest,
					method: request.method as HttpMethod,
					url: resolvedUrl,
					headers: resolvedHeaders,
					body: resolvedBody,
					bodyType:
						request.bodyMode === "json"
							? "json"
							: request.bodyMode === "form-data"
								? "form-data"
								: request.bodyMode === "x-www-form-urlencoded"
									? "x-www-form-urlencoded"
									: request.bodyMode === "text"
										? "text"
										: undefined,
					auth:
						request.authType !== "none"
							? {
								type:
									request.authType === "bearer"
										? "bearer"
										: request.authType === "basic"
											? "basic"
											: request.authType === "api-key"
												? "api-key"
												: "bearer",
								...resolvedAuthConfig,
							}
							: undefined,
					preRequestScript: request.preRequestScript || undefined,
					postRequestScript: request.testScript || undefined,
				};

				const result = await engineExecuteRequest(
					engineRequest,
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

			await updateRequestMutation.mutateAsync({
				id: fetchedRequest.id,
				name: request.name,
				method: request.method as HttpMethod,
				url: request.url,
				headers: keyValueToRecord(request.headers),
				params: keyValueToRecord(request.params),
				body: request.body || undefined,
				bodyType: request.bodyMode || undefined,
				auth:
					request.authType !== "none"
						? {
							type:
								request.authType === "bearer"
									? "bearer"
									: request.authType === "basic"
										? "basic"
										: request.authType === "api-key"
											? "api-key"
											: "bearer",
							...request.authConfig,
						}
						: undefined,
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
					Object.entries(keyValueToRecord(pendingLoadTestRequest.headers)).map(
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
					// HTTP request fields at root level
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
