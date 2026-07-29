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
 *
 * **The MCP copy (`app/electron/mcp/resolve.ts`) is deliberately not changed
 * alongside this file.** CLAUDE.md requires the two resolution copies to move
 * together when *semantics* change, and they have not: the winner is still the
 * last enabled definition in the same precedence order, byte for byte. What is
 * new here is `getVariableOrigins`, which keeps the definitions that lost so the
 * UI can explain the winner. MCP renders nothing and has no use for it, so
 * duplicating it there would add a second copy of something with no reader.
 */

import { useMemo, useCallback } from "react";
import { useGlobalsQuery, useCollectionsQuery, useEnvironmentsQuery } from "@/queries";
import { useSessionStore } from "@/stores";
import type { VariableValue, ResolvedVariable, VariableOrigin, Collection } from "@/types";
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
	/**
	 * Every definition of a name, lowest precedence first, including the disabled
	 * ones that never resolve. Empty array for a name nothing defines.
	 *
	 * Display-only: nothing about execution reads this. See the note on
	 * `VariableOrigin` for why the losers are worth keeping.
	 */
	getVariableOrigins: (name: string) => VariableOrigin[];
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

	/**
	 * Every definition of every name, in precedence order (lowest first):
	 * globals < collection chain (root → leaf) < environment.
	 *
	 * Disabled definitions are collected too. They never resolve, but they are
	 * the answer to "why is this not the value I set?" more often than shadowing
	 * is, and a list built by skipping them cannot say so.
	 *
	 * The winner is marked here rather than inferred by position: once disabled
	 * definitions are in the list, "last" and "wins" are different things.
	 */
	const originsByName = useMemo(() => {
		const result: Record<string, VariableOrigin[]> = {};

		const push = (
			name: string,
			v: VariableValue,
			scope: VariableOrigin["scope"],
			source?: { id: string; name: string }
		) => {
			(result[name] ??= []).push({
				scope,
				sourceId: source?.id,
				sourceName: source?.name,
				value: v.value,
				secret: v.secret,
				type: v.type,
				enabled: !!v.enabled,
				// Filled in below, once the whole list for this name exists.
				winner: false,
			});
		};

		// 1. Globals (lowest priority). A singleton, so no source name.
		for (const [key, val] of Object.entries(globalsData?.variables ?? {})) {
			push(key, val as VariableValue, "global");
		}

		// 2. Collection chain - root-first so leaf variables override parent ones.
		//    Each collection is its own origin: two collections in one chain both
		//    have scope "collection", and collapsing them by scope would hide the
		//    override that actually happened.
		if (activeCollectionId) {
			for (const col of buildCollectionChain(activeCollectionId, collections)) {
				for (const [key, val] of Object.entries(col.variables ?? {})) {
					push(key, val as VariableValue, "collection", { id: col.id, name: col.name });
				}
			}
		}

		// 3. Environment (highest priority)
		if (activeEnvironmentId) {
			const env = environments.find((e) => e.id === activeEnvironmentId);
			if (env) {
				for (const [key, val] of Object.entries(env.variables ?? {})) {
					push(key, val as VariableValue, "environment", { id: env.id, name: env.name });
				}
			}
		}

		// The winner is the *last enabled* definition, which is exactly the value
		// the old overwrite-as-you-go loop arrived at.
		for (const list of Object.values(result)) {
			for (let i = list.length - 1; i >= 0; i--) {
				if (list[i].enabled) {
					list[i].winner = true;
					break;
				}
			}
		}

		return result;
	}, [globalsData, collections, environments, activeCollectionId, activeEnvironmentId]);

	/**
	 * The resolved value per name - derived from the origins rather than built
	 * alongside them, so the two cannot disagree about which definition won.
	 */
	const variableMap = useMemo(() => {
		const result: Record<string, ResolvedVariable> = {};
		for (const [name, origins] of Object.entries(originsByName)) {
			const won = origins.find((o) => o.winner);
			// Every definition disabled: the name resolves to nothing, exactly as
			// before. `hasUnresolvedVariables` and the red token both depend on it
			// being absent rather than present-and-empty.
			if (!won) continue;
			result[name] = {
				value: won.value,
				scope: won.scope,
				secret: won.secret,
				sourceId: won.sourceId,
				sourceName: won.sourceName,
				type: won.type,
				typedValue: castByType(won.value, won.type),
			};
		}
		return result;
	}, [originsByName]);

	const getVariable = useCallback(
		(name: string): ResolvedVariable | null => variableMap[name] || null,
		[variableMap]
	);

	const getAllVariables = useCallback(
		(): Record<string, ResolvedVariable> => ({ ...variableMap }),
		[variableMap]
	);

	const getVariableOrigins = useCallback(
		(name: string): VariableOrigin[] => originsByName[name] ?? [],
		[originsByName]
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

	return {
		resolveString,
		resolveObject,
		getVariable,
		getAllVariables,
		hasUnresolvedVariables,
		getVariableOrigins,
	};
}
