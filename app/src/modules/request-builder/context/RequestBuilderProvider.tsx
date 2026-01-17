
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestBuilder Provider
 *
 * Provides:
 * - Request state management
 * - Variable resolution layer
 * - Execute/save actions
 * - Response state (persisted via store)
 * - Auto-save with debouncing
 */

import { useState, useCallback, useMemo, useEffect, useRef, type ReactNode } from "react";
import { RequestBuilderContext } from "./RequestBuilderContext";
import { useVariableResolver, useSaveManager } from "@/hooks";
import {
	useGlobalsQuery,
	useUpdateGlobalsMutation,
	useCollectionsQuery,
	useUpdateCollectionMutation,
	useEnvironmentsQuery,
	useUpdateEnvironmentMutation,
	useLastDesignRunQuery,
} from "@/queries";
import { useVariablesStore, useResponseStore } from "@/stores";
import type { VariableValue } from "@/types";
import type {
	RequestState,
	ResponseState,
	RequestTab,
	VariableInfo,
	VariableScope,
	RequestBuilderContextValue,
} from "../types";
import { createDefaultRequestState } from "../utils/request-state";

interface RequestBuilderProviderProps {
	children: ReactNode;
	initialRequest?: Partial<RequestState>;
	collectionId?: string | null;
	onExecute?: (request: RequestState) => Promise<ResponseState | null>;
	onSave?: (request: RequestState) => Promise<void>;
	onStartLoadTest?: (request: RequestState) => void;
}

export default function RequestBuilderProvider({
	children,
	initialRequest,
	collectionId,
	onExecute,
	onSave,
	onStartLoadTest,
}: RequestBuilderProviderProps) {
	// Request state
	const [request, setRequestState] = useState<RequestState>(() => ({
		...createDefaultRequestState(),
		...initialRequest,
		collectionId: collectionId || null,
	}));

	// Response state - use store for persistence across view switches
	const { getResponse, setResponse: storeSetResponse } = useResponseStore();
	const [response, setLocalResponse] = useState<ResponseState | null>(() => {
		// Initialize from store if available
		const requestId = initialRequest?.id;
		if (requestId) {
			const stored = getResponse(requestId);
			if (stored) {
				return stored as ResponseState;
			}
		}
		return null;
	});

	// Wrapper to update both local state and store
	const setResponse = useCallback(
		(newResponse: ResponseState | null) => {
			setLocalResponse(newResponse);
			const requestId = request.id;
			if (requestId && newResponse) {
				storeSetResponse(requestId, newResponse);
			}
		},
		[request.id, storeSetResponse]
	);

	// Fetch last design run from backend (for app reload scenarios)
	const { report: lastDesignRunReport, isLoading: isLoadingLastRun } = useLastDesignRunQuery(
		request.id
	);
	const hasLoadedFromBackend = useRef<string | null>(null);

	// Load response from backend if we don't have one cached and backend has a previous run
	useEffect(() => {
		// Skip if no request ID or already have a response
		if (!request.id || response) return;

		// Skip if already loaded for this request ID
		if (hasLoadedFromBackend.current === request.id) return;

		// Skip if still loading
		if (isLoadingLastRun) return;

		// Try to reconstruct response from last design run
		if (lastDesignRunReport?.results && lastDesignRunReport.results.length > 0) {
			const lastResult = lastDesignRunReport.results[0];
			const trace = lastResult.trace as any;

			if (trace?.response) {
				// Determine body type
				let bodyType: "json" | "html" | "xml" | "text" | "binary" = "text";
				const body =
					typeof trace.response.body === "string"
						? trace.response.body
						: JSON.stringify(trace.response.body, null, 2);

				try {
					JSON.parse(body);
					bodyType = "json";
				} catch {
					if (body.includes("<html") || body.includes("<!DOCTYPE")) {
						bodyType = "html";
					} else if (body.includes("<?xml") || body.includes("<xml")) {
						bodyType = "xml";
					}
				}

				const restoredResponse: ResponseState = {
					status: lastResult.statusCode || 0,
					statusText: `${lastResult.statusCode || 0}`,
					headers: trace.response.headers || {},
					requestHeaders: trace.request?.headers || {},
					rawRequest: trace.request
						? `${trace.request.method} ${trace.request.url}`
						: undefined,
					body,
					bodyType,
					size: body.length,
					time: lastResult.latencyMs || 0,
					timestamp: new Date(lastResult.timestamp).toISOString(),
				};

				setLocalResponse(restoredResponse);
				storeSetResponse(request.id, restoredResponse);
				hasLoadedFromBackend.current = request.id;
			}
		}

		// Mark as loaded even if no response found
		hasLoadedFromBackend.current = request.id;
	}, [request.id, response, lastDesignRunReport, isLoadingLastRun, storeSetResponse]);

	// UI state
	const [activeTab, setActiveTab] = useState<RequestTab>("params");
	const [isExecuting, setIsExecuting] = useState(false);
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

	// Variable resolution
	const {
		resolveString,
		getVariable: resolverGetVariable,
		getAllVariables: resolverGetAllVariables,
	} = useVariableResolver({ collectionId: collectionId || undefined });

	// Variable update mutations
	const { activeEnvironmentId } = useVariablesStore();
	const { data: globalsData } = useGlobalsQuery();
	const { data: collections = [] } = useCollectionsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();
	const updateGlobalsMutation = useUpdateGlobalsMutation();
	const updateCollectionMutation = useUpdateCollectionMutation();
	const updateEnvironmentMutation = useUpdateEnvironmentMutation();

	// Reset when initial request changes
	useEffect(() => {
		if (initialRequest) {
			setRequestState({
				...createDefaultRequestState(),
				...initialRequest,
				collectionId: collectionId || null,
			});
			setHasUnsavedChanges(false);

			// Restore response from store for this request
			const requestId = initialRequest.id;
			if (requestId) {
				const stored = getResponse(requestId);
				if (stored) {
					setLocalResponse(stored as ResponseState);
				} else {
					setLocalResponse(null);
				}
				// Reset backend loading flag to allow reloading from backend if needed
				hasLoadedFromBackend.current = null;
			} else {
				setLocalResponse(null);
			}
		}
	}, [initialRequest?.id, collectionId, getResponse]);

	// Centralized save manager - handles auto-save, keyboard shortcut, and status
	const handleSave = useCallback(async () => {
		if (!onSave) return;
		await onSave(request);
		setHasUnsavedChanges(false);
	}, [request, onSave]);

	const {
		forceSave,
		status: saveStatus,
		isSaving,
	} = useSaveManager({
		entityId: request.id || null,
		onSave: handleSave,
		hasChanges: hasUnsavedChanges,
		enabled: !!onSave,
	});

	// Set request with change tracking
	const setRequest = useCallback((updates: Partial<RequestState>) => {
		setRequestState((prev) => ({ ...prev, ...updates }));
		setHasUnsavedChanges(true);
	}, []);

	// saveRequest now uses the centralized forceSave
	const saveRequest = useCallback(async () => {
		await forceSave();
	}, [forceSave]);

	// Update single field
	const updateField = useCallback(
		<K extends keyof RequestState>(field: K, value: RequestState[K]) => {
			setRequest({ [field]: value } as Partial<RequestState>);
		},
		[setRequest]
	);

	// Get variable info
	const getVariable = useCallback(
		(name: string): VariableInfo | null => {
			const info = resolverGetVariable(name);
			if (!info) return null;
			return { value: info.value, scope: info.scope };
		},
		[resolverGetVariable]
	);

	// Get all variables
	const getAllVariables = useCallback((): Record<string, VariableInfo> => {
		const vars = resolverGetAllVariables();
		const result: Record<string, VariableInfo> = {};
		for (const [name, source] of Object.entries(vars)) {
			result[name] = { value: source.value, scope: source.scope };
		}
		return result;
	}, [resolverGetAllVariables]);

	// Update variable value
	const updateVariable = useCallback(
		(name: string, newValue: string, scope: VariableScope) => {
			switch (scope) {
				case "global": {
					if (!globalsData?.variables) return;
					const updatedVars: Record<string, VariableValue> = { ...globalsData.variables };
					if (updatedVars[name]) {
						updatedVars[name] = { ...updatedVars[name], value: newValue };
					} else {
						updatedVars[name] = { value: newValue, enabled: true };
					}
					updateGlobalsMutation.mutate({ variables: updatedVars });
					break;
				}
				case "collection": {
					if (!collectionId) return;
					const collection = collections.find((c) => c.id === collectionId);
					if (!collection) return;
					const updatedVars: Record<string, VariableValue> = { ...collection.variables };
					if (updatedVars[name]) {
						updatedVars[name] = { ...updatedVars[name], value: newValue };
					} else {
						updatedVars[name] = { value: newValue, enabled: true };
					}
					updateCollectionMutation.mutate({ id: collectionId, variables: updatedVars });
					break;
				}
				case "environment": {
					if (!activeEnvironmentId) return;
					const environment = environments.find((e) => e.id === activeEnvironmentId);
					if (!environment) return;
					const updatedVars: Record<string, VariableValue> = { ...environment.variables };
					if (updatedVars[name]) {
						updatedVars[name] = { ...updatedVars[name], value: newValue };
					} else {
						updatedVars[name] = { value: newValue, enabled: true };
					}
					updateEnvironmentMutation.mutate({
						id: activeEnvironmentId,
						variables: updatedVars,
					});
					break;
				}
			}
		},
		[
			globalsData,
			collections,
			environments,
			collectionId,
			activeEnvironmentId,
			updateGlobalsMutation,
			updateCollectionMutation,
			updateEnvironmentMutation,
		]
	);

	// Execute request
	const executeRequest = useCallback(async () => {
		if (!onExecute) return;

		setIsExecuting(true);
		setResponse(null);

		try {
			const result = await onExecute(request);
			if (result) {
				setResponse(result);
			}
		} catch (error) {
			console.error("Request execution failed:", error);
		} finally {
			setIsExecuting(false);
		}
	}, [request, onExecute]);

	// Start load test
	const startLoadTest = useCallback(() => {
		if (onStartLoadTest) {
			onStartLoadTest(request);
		}
	}, [request, onStartLoadTest]);

	// Context value
	const contextValue = useMemo<RequestBuilderContextValue>(
		() => ({
			request,
			setRequest,
			updateField,
			response,
			setResponse,
			activeTab,
			setActiveTab,
			isExecuting,
			isSaving,
			hasUnsavedChanges,
			saveStatus,
			resolveString,
			resolveVariables: resolveString,
			getVariable,
			getAllVariables,
			updateVariable,
			executeRequest,
			saveRequest,
			startLoadTest,
		}),
		[
			request,
			setRequest,
			updateField,
			response,
			activeTab,
			isExecuting,
			isSaving,
			hasUnsavedChanges,
			saveStatus,
			resolveString,
			getVariable,
			getAllVariables,
			updateVariable,
			executeRequest,
			saveRequest,
			startLoadTest,
		]
	);

	return (
		<RequestBuilderContext.Provider value={contextValue}>
			{children}
		</RequestBuilderContext.Provider>
	);
}
