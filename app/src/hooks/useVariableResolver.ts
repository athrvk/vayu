/**
 * useVariableResolver Hook
 *
 * Provides functions to resolve {{variables}} in strings using the current
 * variable context (globals, active collection, active environment).
 *
 * Resolution priority: Environment > Collection > Global
 */

import { useMemo, useCallback } from "react";
import { useGlobalsQuery, useCollectionsQuery, useEnvironmentsQuery } from "@/queries";
import { useVariablesStore, useEnvironmentStore } from "@/stores";
import type { VariableValue } from "@/types";

interface VariableSource {
    value: string;
    scope: "global" | "collection" | "environment";
}

interface UseVariableResolverOptions {
    /** Override collection ID (e.g., from current request) */
    collectionId?: string;
}

interface UseVariableResolverReturn {
    /** Resolve all {{variables}} in a string */
    resolveString: (input: string) => string;

    /** Resolve variables in an object (deep, including nested strings) */
    resolveObject: <T>(obj: T) => T;

    /** Get resolved value for a specific variable name */
    getVariable: (name: string) => VariableSource | null;

    /** Get all available variables with their sources */
    getAllVariables: () => Record<string, VariableSource>;

    /** Check if a string contains any unresolved variables */
    hasUnresolvedVariables: (input: string) => boolean;
}

const VARIABLE_PATTERN = /\{\{([^{}]+)\}\}/g;

export function useVariableResolver(options?: UseVariableResolverOptions): UseVariableResolverReturn {
    // Fetch all variable sources
    const { data: globalsData } = useGlobalsQuery();
    const { data: collections = [] } = useCollectionsQuery();
    const { data: environments = [] } = useEnvironmentsQuery();
    
    // Get active environment from environment store (used throughout the app)
    const { activeEnvironmentId } = useEnvironmentStore();
    // Get collection ID from options or variables store
    const { activeCollectionId: storeCollectionId } = useVariablesStore();
    
    // Use option collectionId if provided, otherwise fall back to store
    const activeCollectionId = options?.collectionId || storeCollectionId;

    // Build flat variable map with sources
    const variableMap = useMemo(() => {
        const result: Record<string, VariableSource> = {};

        // Add globals first (lowest priority)
        if (globalsData?.variables) {
            for (const [key, val] of Object.entries(globalsData.variables)) {
                const v = val as VariableValue;
                if (v.enabled) {
                    result[key] = { value: v.value, scope: "global" };
                }
            }
        }

        // Add collection variables (medium priority, overwrites globals)
        if (activeCollectionId) {
            const col = collections.find((c) => c.id === activeCollectionId);
            if (col?.variables) {
                for (const [key, val] of Object.entries(col.variables)) {
                    const v = val as VariableValue;
                    if (v.enabled) {
                        result[key] = { value: v.value, scope: "collection" };
                    }
                }
            }
        }

        // Add environment variables (highest priority, overwrites all)
        if (activeEnvironmentId) {
            const env = environments.find((e) => e.id === activeEnvironmentId);
            if (env?.variables) {
                for (const [key, val] of Object.entries(env.variables)) {
                    const v = val as VariableValue;
                    if (v.enabled) {
                        result[key] = { value: v.value, scope: "environment" };
                    }
                }
            }
        }

        return result;
    }, [globalsData, collections, environments, activeCollectionId, activeEnvironmentId]);

    const getVariable = useCallback(
        (name: string): VariableSource | null => {
            return variableMap[name] || null;
        },
        [variableMap]
    );

    const getAllVariables = useCallback((): Record<string, VariableSource> => {
        return { ...variableMap };
    }, [variableMap]);

    const resolveString = useCallback(
        (input: string): string => {
            if (!input || typeof input !== "string") return input;

            return input.replace(VARIABLE_PATTERN, (match, varName) => {
                const trimmedName = varName.trim();
                const source = variableMap[trimmedName];
                return source ? source.value : match; // Keep original if not found
            });
        },
        [variableMap]
    );

    const resolveObject = useCallback(
        <T,>(obj: T): T => {
            if (obj === null || obj === undefined) return obj;

            if (typeof obj === "string") {
                return resolveString(obj) as unknown as T;
            }

            if (Array.isArray(obj)) {
                return obj.map((item) => resolveObject(item)) as unknown as T;
            }

            if (typeof obj === "object") {
                const result: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
                    result[key] = resolveObject(value);
                }
                return result as T;
            }

            return obj;
        },
        [resolveString]
    );

    const hasUnresolvedVariables = useCallback(
        (input: string): boolean => {
            if (!input || typeof input !== "string") return false;

            const matches = input.match(VARIABLE_PATTERN);
            if (!matches) return false;

            return matches.some((match) => {
                const varName = match.slice(2, -2).trim();
                return !variableMap[varName];
            });
        },
        [variableMap]
    );

    return {
        resolveString,
        resolveObject,
        getVariable,
        getAllVariables,
        hasUnresolvedVariables,
    };
}
