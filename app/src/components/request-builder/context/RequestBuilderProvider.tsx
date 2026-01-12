/**
 * RequestBuilder Provider
 * 
 * Provides:
 * - Request state management
 * - Variable resolution layer
 * - Execute/save actions
 * - Response state
 * - Auto-save with debouncing
 */

import { useState, useCallback, useMemo, useEffect, type ReactNode } from "react";
import { RequestBuilderContext } from "./RequestBuilderContext";
import { useVariableResolver, useSaveManager } from "@/hooks";
import {
    useGlobalsQuery,
    useUpdateGlobalsMutation,
    useCollectionsQuery,
    useUpdateCollectionMutation,
    useEnvironmentsQuery,
    useUpdateEnvironmentMutation
} from "@/queries";
import { useEnvironmentStore } from "@/stores";
import type { VariableValue } from "@/types";
import type {
    RequestState,
    ResponseState,
    RequestTab,
    VariableInfo,
    VariableScope,
    RequestBuilderContextValue
} from "../types";
import { createDefaultRequestState } from "../types";

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

    // Response state
    const [response, setResponse] = useState<ResponseState | null>(null);

    // UI state
    const [activeTab, setActiveTab] = useState<RequestTab>("params");
    const [isExecuting, setIsExecuting] = useState(false);
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

    // Variable resolution
    const { resolveString, getVariable: resolverGetVariable, getAllVariables: resolverGetAllVariables } =
        useVariableResolver({ collectionId: collectionId || undefined });

    // Variable update mutations
    const { activeEnvironmentId } = useEnvironmentStore();
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
        }
    }, [initialRequest?.id, collectionId]);

    // Centralized save manager - handles auto-save, keyboard shortcut, and status
    const handleSave = useCallback(async () => {
        if (!onSave) return;
        await onSave(request);
        setHasUnsavedChanges(false);
    }, [request, onSave]);

    const { forceSave, status: saveStatus, isSaving } = useSaveManager({
        entityId: request.id || null,
        onSave: handleSave,
        hasChanges: hasUnsavedChanges,
        enabled: !!onSave,
    });

    // Set request with change tracking
    const setRequest = useCallback((updates: Partial<RequestState>) => {
        setRequestState(prev => ({ ...prev, ...updates }));
        setHasUnsavedChanges(true);
    }, []);

    // saveRequest now uses the centralized forceSave
    const saveRequest = useCallback(async () => {
        await forceSave();
    }, [forceSave]);

    // Update single field
    const updateField = useCallback(<K extends keyof RequestState>(field: K, value: RequestState[K]) => {
        setRequest({ [field]: value } as Partial<RequestState>);
    }, [setRequest]);

    // Get variable info
    const getVariable = useCallback((name: string): VariableInfo | null => {
        const info = resolverGetVariable(name);
        if (!info) return null;
        return { value: info.value, scope: info.scope };
    }, [resolverGetVariable]);

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
    const updateVariable = useCallback((name: string, newValue: string, scope: VariableScope) => {
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
                const collection = collections.find(c => c.id === collectionId);
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
                const environment = environments.find(e => e.id === activeEnvironmentId);
                if (!environment) return;
                const updatedVars: Record<string, VariableValue> = { ...environment.variables };
                if (updatedVars[name]) {
                    updatedVars[name] = { ...updatedVars[name], value: newValue };
                } else {
                    updatedVars[name] = { value: newValue, enabled: true };
                }
                updateEnvironmentMutation.mutate({ id: activeEnvironmentId, variables: updatedVars });
                break;
            }
        }
    }, [globalsData, collections, environments, collectionId, activeEnvironmentId,
        updateGlobalsMutation, updateCollectionMutation, updateEnvironmentMutation]);

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
    const contextValue = useMemo<RequestBuilderContextValue>(() => ({
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
    }), [
        request, setRequest, updateField, response, activeTab, isExecuting,
        isSaving, hasUnsavedChanges, saveStatus, resolveString, getVariable, getAllVariables,
        updateVariable, executeRequest, saveRequest, startLoadTest
    ]);

    return (
        <RequestBuilderContext.Provider value={contextValue}>
            {children}
        </RequestBuilderContext.Provider>
    );
}
