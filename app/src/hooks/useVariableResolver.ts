/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useVariableResolver Hook
 *
 * Provides functions to resolve {{variables}} in strings using the current
 * variable context (globals, collection chain, active environment).
 *
 * Resolution priority (highest wins): Environment > Collection chain (leaf → root) > Global
 * Within the collection chain, variables closer to the leaf override those closer to the root.
 * Cached per (collectionId, environmentId) via useMemo.
 */

import { useMemo, useCallback } from "react";
import { useGlobalsQuery, useCollectionsQuery, useEnvironmentsQuery } from "@/queries";
import { useSessionStore } from "@/stores";
import type { VariableValue, ResolvedVariable, Collection } from "@/types";
import { castByType } from "@/lib/variable-cast";

interface UseVariableResolverOptions {
	collectionId?: string;
}

interface UseVariableResolverReturn {
	resolveString: (input: string) => string;
	resolveObject: <T>(obj: T) => T;
	getVariable: (name: string) => ResolvedVariable | null;
	getAllVariables: () => Record<string, ResolvedVariable>;
	hasUnresolvedVariables: (input: string) => boolean;
}

const VARIABLE_PATTERN = /\{\{([^{}]+)\}\}/g;

/** Build root-first ancestor chain for a collection (inclusive of the collection itself). */
function buildCollectionChain(startId: string, collections: Collection[]): Collection[] {
	const chain: Collection[] = [];
	let currentId: string | undefined = startId;
	while (currentId) {
		const col = collections.find((c) => c.id === currentId);
		if (!col) break;
		chain.unshift(col); // root first
		currentId = col.parentId;
	}
	return chain;
}

export function useVariableResolver(
	options?: UseVariableResolverOptions
): UseVariableResolverReturn {
	const { data: globalsData } = useGlobalsQuery();
	const { data: collections = [] } = useCollectionsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();

	const { activeEnvironmentId, activeCollectionId: storeCollectionId } = useSessionStore();
	const activeCollectionId = options?.collectionId || storeCollectionId;

	// Build variable map with hierarchical resolution:
	// globals < collection chain (root → leaf) < environment
	const variableMap = useMemo(() => {
		const result: Record<string, ResolvedVariable> = {};

		const resolve = (v: VariableValue, scope: ResolvedVariable["scope"]): ResolvedVariable => ({
			value: v.value,
			scope,
			secret: v.secret,
			type: v.type,
			typedValue: castByType(v.value, v.type),
		});

		// 1. Globals (lowest priority)
		if (globalsData?.variables) {
			for (const [key, val] of Object.entries(globalsData.variables)) {
				const v = val as VariableValue;
				if (v.enabled) result[key] = resolve(v, "global");
			}
		}

		// 2. Collection chain — root-first so leaf variables override parent variables
		if (activeCollectionId) {
			const chain = buildCollectionChain(activeCollectionId, collections);
			for (const col of chain) {
				if (col.variables) {
					for (const [key, val] of Object.entries(col.variables)) {
						const v = val as VariableValue;
						if (v.enabled) result[key] = resolve(v, "collection");
					}
				}
			}
		}

		// 3. Environment (highest priority)
		if (activeEnvironmentId) {
			const env = environments.find((e) => e.id === activeEnvironmentId);
			if (env?.variables) {
				for (const [key, val] of Object.entries(env.variables)) {
					const v = val as VariableValue;
					if (v.enabled) result[key] = resolve(v, "environment");
				}
			}
		}

		return result;
	}, [globalsData, collections, environments, activeCollectionId, activeEnvironmentId]);

	const getVariable = useCallback(
		(name: string): ResolvedVariable | null => variableMap[name] || null,
		[variableMap]
	);

	const getAllVariables = useCallback(
		(): Record<string, ResolvedVariable> => ({ ...variableMap }),
		[variableMap]
	);

	const resolveString = useCallback(
		(input: string): string => {
			if (!input || typeof input !== "string") return input;
			return input.replace(VARIABLE_PATTERN, (_match, varName) => {
				const source = variableMap[varName.trim()];
				return source ? source.value : "";
			});
		},
		[variableMap]
	);

	const resolveObject = useCallback(
		<T>(obj: T): T => {
			// Recurse via a local function rather than the `resolveObject` const so the
			// reference isn't to a not-yet-declared binding (react-hooks/immutability).
			const recurse = <U>(value: U): U => {
				if (value === null || value === undefined) return value;
				if (typeof value === "string") return resolveString(value) as unknown as U;
				if (Array.isArray(value)) return value.map((item) => recurse(item)) as unknown as U;
				if (typeof value === "object") {
					const result: Record<string, unknown> = {};
					for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
						result[key] = recurse(val);
					}
					return result as U;
				}
				return value;
			};
			return recurse(obj);
		},
		[resolveString]
	);

	const hasUnresolvedVariables = useCallback(
		(input: string): boolean => {
			if (!input || typeof input !== "string") return false;
			const matches = input.match(VARIABLE_PATTERN);
			if (!matches) return false;
			return matches.some((match) => !variableMap[match.slice(2, -2).trim()]);
		},
		[variableMap]
	);

	return { resolveString, resolveObject, getVariable, getAllVariables, hasUnresolvedVariables };
}
