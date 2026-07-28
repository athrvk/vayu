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
import { emptyDrafts, type BodyDrafts } from "../utils/body-drafts";
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
import { useSessionStore, useResponseStore } from "@/stores";
import type { ScriptPart, VariableValue } from "@/types";
import type {
	AutoContentType,
	RequestState,
	ResponseState,
	RequestTab,
	VariableInfo,
	VariableScope,
	RequestBuilderContextValue,
} from "../types";
import { createDefaultRequestState } from "../utils/request-state";
import { responseFromRunResult } from "../utils/restore-response";

interface RequestBuilderProviderProps {
	children: ReactNode;
	initialRequest?: Partial<RequestState>;
	/**
	 * Starting response for a builder with no id, which cannot read the store.
	 * Used by the History run view, where the response comes from the run.
	 *
	 * Keep the reference stable (memoize it): it is read by the reset effect
	 * below, not only by the `useState` initialiser.
	 */
	initialResponse?: ResponseState | null;
	/**
	 * Script parts to show as "runs before your own" instead of the live
	 * collection chain. The History run view passes what the run recorded, so a
	 * copy of a past run lists the scripts that actually ran, not the ones the
	 * collection carries today.
	 */
	inheritedPreScripts?: ScriptPart[];
	inheritedPostScripts?: ScriptPart[];
	/**
	 * The whole glued script a run recorded before script parts existed. Shown
	 * read-only, because its collection and request halves cannot be separated
	 * and the editor above is therefore necessarily empty.
	 */
	legacyPreScript?: string;
	legacyPostScript?: string;
	collectionId?: string | null;
	onExecute?: (request: RequestState) => Promise<ResponseState | null>;
	onSave?: (request: RequestState) => Promise<void>;
	onStartLoadTest?: (request: RequestState) => void;
}

export default function RequestBuilderProvider({
	children,
	initialRequest,
	initialResponse,
	inheritedPreScripts,
	inheritedPostScripts,
	legacyPreScript,
	legacyPostScript,
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

	// The id of the request currently on screen. This single provider is reused
	// across request tabs (no per-tab key), so an execute that is still in flight
	// when the user switches requests must be able to tell whether its result
	// still belongs on screen. A ref, not the closure's `request`, because the
	// running executeRequest closed over the request that was active at Send.
	const currentRequestIdRef = useRef<string | null>(request.id ?? null);
	useEffect(() => {
		currentRequestIdRef.current = request.id ?? null;
	}, [request.id]);

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
		// Nothing stored - a detached copy has no id to look one up by, so it
		// hands its response in directly.
		return initialResponse ?? null;
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
	const {
		run: lastDesignRun,
		report: lastDesignRunReport,
		isLoading: isLoadingLastRun,
	} = useLastDesignRunQuery(request.id);
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
		const restoredResponse = responseFromRunResult(
			lastDesignRunReport?.results?.[0],
			lastDesignRun?.id
		);
		if (restoredResponse) {
			setLocalResponse(restoredResponse);
			storeSetResponse(request.id, restoredResponse);
			hasLoadedFromBackend.current = request.id;
		}

		// Mark as loaded even if no response found
		hasLoadedFromBackend.current = request.id;
	}, [
		request.id,
		response,
		lastDesignRun,
		lastDesignRunReport,
		isLoadingLastRun,
		storeSetResponse,
	]);

	// UI state
	const [activeTab, setActiveTab] = useState<RequestTab>("params");
	const [isExecuting, setIsExecuting] = useState(false);
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

	/*
	 * What the body modes you are not looking at were holding. It lives here
	 * rather than in `BodyPanel` because Radix unmounts an inactive
	 * `TabsContent`: a panel-local ref is discarded the moment you glance at the
	 * Headers tab, and your stashed JSON with it.
	 *
	 * Not reset by the request-change effect below, deliberately. The drafts
	 * carry their own `requestId` and `switchBody` drops any that belong to
	 * another request, so a second reset here would be a copy of that rule that
	 * could fall out of step with it - and would fire on a *save*, when an
	 * unsaved request is first assigned an id, wiping drafts the user still has.
	 */
	const bodyDraftsRef = useRef<BodyDrafts>(emptyDrafts(initialRequest?.id ?? null));
	const getBodyDrafts = useCallback(() => bodyDraftsRef.current, []);
	const setBodyDrafts = useCallback((drafts: BodyDrafts) => {
		bodyDraftsRef.current = drafts;
	}, []);

	/*
	 * The Content-Type row a body mode added on its way in, so leaving the mode
	 * can remove it again. Here rather than in `BodyPanel` for the drafts' reason
	 * and one of its own: the panel is unmounted whenever another tab is on
	 * screen, so a panel-local record is gone by the next mode change - and then
	 * the header outlives the mode that needed it, which is the bug the record
	 * exists to fix.
	 *
	 * Not reset by the request-change effect below, for the same reason as the
	 * drafts: the record names its own request and `switchContentType` drops one
	 * belonging to another.
	 */
	const autoContentTypeRef = useRef<AutoContentType | null>(null);
	const getAutoContentType = useCallback(() => autoContentTypeRef.current, []);
	const setAutoContentType = useCallback((auto: AutoContentType | null) => {
		autoContentTypeRef.current = auto;
	}, []);

	// Variable resolution
	const {
		resolveString,
		getVariable: resolverGetVariable,
		getAllVariables: resolverGetAllVariables,
		getVariableOrigins,
	} = useVariableResolver({ collectionId: collectionId || undefined });

	// Variable update mutations
	const { activeEnvironmentId } = useSessionStore();
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
			// Clear any executing state carried over from the request we just left.
			// It belongs to that request's in-flight run, not this one; without this
			// the switched-to request shows a "Sending" spinner it never triggered.
			setIsExecuting(false);

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
				/*
				 * No id, so there is no stored response to restore - fall back to
				 * the one handed in. This runs on mount as well as on a change of
				 * request, so clearing it unconditionally (as it used to) threw
				 * away `initialResponse` immediately after the initialiser above
				 * had set it, and a detached copy opened showing "No response yet".
				 */
				setLocalResponse(initialResponse ?? null);
			}
		}
		// initialRequest intentionally keyed by .id only: depending on the full
		// object would reset local state (discarding unsaved edits) on every
		// parent re-render that passes a new object reference.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [initialRequest?.id, collectionId, getResponse, initialResponse]);

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
			return { value: info.value, scope: info.scope, secret: info.secret };
		},
		[resolverGetVariable]
	);

	// Get all variables.
	//
	// Passed through rather than re-picked field by field. The old version
	// rebuilt each entry as `{ value, scope, secret }`, which silently dropped
	// `sourceName` / `sourceId` (so the popover could name a scope but not the
	// environment) along with `type` / `typedValue`. A hand-copied projection of
	// a type is a place fields go to die; the resolver already produces exactly
	// this shape.
	const getAllVariables = useCallback(
		(): Record<string, VariableInfo> => resolverGetAllVariables(),
		[resolverGetAllVariables]
	);

	/*
	 * Merge one variable into a scope's map.
	 *
	 * Written once rather than three times. The three branches below were
	 * identical apart from where they wrote, and identical code in three places
	 * is three places for a rule to diverge - which is what happened: each
	 * spread the existing entry to keep its flags, so writing a value to a
	 * variable that was **disabled** preserved `enabled: false`.
	 *
	 * That produced exactly the dead end the popover's Create button exists to
	 * remove. A name disabled at every scope does not resolve, so the token is
	 * red and the popover offers to create it; the write then landed on the
	 * disabled entry, kept it disabled, and the token stayed red. The button
	 * appeared to work and changed nothing visible.
	 *
	 * So a write through this path always enables. Setting a value here means
	 * "make this value apply" - there is no caller for whom writing a value and
	 * leaving it switched off is the intent, and the variables editor is where
	 * enabling and disabling actually belongs.
	 */
	const mergeVariable = (
		existing: Record<string, VariableValue> | undefined,
		name: string,
		newValue: string
	): Record<string, VariableValue> => ({
		...existing,
		[name]: { ...existing?.[name], value: newValue, enabled: true },
	});

	// Update variable value
	const updateVariable = useCallback(
		(name: string, newValue: string, scope: VariableScope) => {
			switch (scope) {
				case "global": {
					if (!globalsData?.variables) return;
					updateGlobalsMutation.mutate({
						variables: mergeVariable(globalsData.variables, name, newValue),
					});
					break;
				}
				case "collection": {
					if (!collectionId) return;
					const collection = collections.find((c) => c.id === collectionId);
					if (!collection) return;
					updateCollectionMutation.mutate({
						id: collectionId,
						variables: mergeVariable(collection.variables, name, newValue),
					});
					break;
				}
				case "environment": {
					if (!activeEnvironmentId) return;
					const environment = environments.find((e) => e.id === activeEnvironmentId);
					if (!environment) return;
					updateEnvironmentMutation.mutate({
						id: activeEnvironmentId,
						variables: mergeVariable(environment.variables, name, newValue),
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

	/*
	 * Which scopes `updateVariable` would actually write to, derived from the
	 * same three guards it opens each branch with.
	 *
	 * Kept beside it deliberately: this is the config-defined-in-one-branch,
	 * re-derived-in-another shape that has bitten this codebase before, so if a
	 * guard changes above, this list is the next thing in the file to change.
	 * A caller that offers a scope not in here gets a silent no-op.
	 */
	const writableScopes = useMemo((): VariableScope[] => {
		const scopes: VariableScope[] = [];
		if (globalsData?.variables) scopes.push("global");
		if (collectionId && collections.some((c) => c.id === collectionId))
			scopes.push("collection");
		if (activeEnvironmentId && environments.some((e) => e.id === activeEnvironmentId)) {
			scopes.push("environment");
		}
		return scopes;
	}, [globalsData, collections, collectionId, environments, activeEnvironmentId]);

	// Execute request
	const executeRequest = useCallback(async () => {
		if (!onExecute) return;

		// Snapshot the request as it is at Send. If the user switches to another
		// request before this resolves, the result must land on the request that
		// actually ran - not on whatever is on screen when it finishes.
		const executingRequest = request;
		const executingId = executingRequest.id;

		setIsExecuting(true);
		setLocalResponse(null);

		try {
			const result = await onExecute(executingRequest);
			if (result) {
				// Persist under the request that ran, so returning to it shows its
				// own response. `storeSetResponse` is keyed by id and is safe even
				// if this provider has since moved on to another request.
				if (executingId) storeSetResponse(executingId, result);
				// Only touch the shared live view if that request is still on
				// screen. The ref reflects the current request, unlike this
				// closure's frozen `executingId`.
				if (currentRequestIdRef.current === executingId) {
					setLocalResponse(result);
				}
			}
		} catch (error) {
			console.error("Request execution failed:", error);
		} finally {
			// Same guard: a stale finish must not clear the spinner of a different
			// request the user has since started.
			if (currentRequestIdRef.current === executingId) {
				setIsExecuting(false);
			}
		}
	}, [request, onExecute, storeSetResponse]);

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
			getBodyDrafts,
			setBodyDrafts,
			getAutoContentType,
			setAutoContentType,
			response,
			setResponse,
			inheritedPreScripts,
			inheritedPostScripts,
			legacyPreScript,
			legacyPostScript,
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
			getVariableOrigins,
			updateVariable,
			writableScopes,
			executeRequest,
			saveRequest,
			startLoadTest,
			canStartLoadTest: !!onStartLoadTest,
		}),
		[
			request,
			setRequest,
			updateField,
			getBodyDrafts,
			setBodyDrafts,
			getAutoContentType,
			setAutoContentType,
			response,
			setResponse,
			inheritedPreScripts,
			inheritedPostScripts,
			legacyPreScript,
			legacyPostScript,
			activeTab,
			isExecuting,
			isSaving,
			hasUnsavedChanges,
			saveStatus,
			resolveString,
			getVariable,
			getAllVariables,
			getVariableOrigins,
			updateVariable,
			writableScopes,
			executeRequest,
			saveRequest,
			startLoadTest,
			onStartLoadTest,
		]
	);

	return (
		<RequestBuilderContext.Provider value={contextValue}>
			{children}
		</RequestBuilderContext.Provider>
	);
}
