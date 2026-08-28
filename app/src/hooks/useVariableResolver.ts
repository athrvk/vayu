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
 * Resolution priority (highest wins): Bound data row (bare column names, only
 * while one is picked) > Environment > Collection chain (leaf → root) > Global
 * Within the collection chain, variables closer to the leaf override those closer to the root.
 * Cached per (collectionId, environmentId) via useMemo.
 *
 * The row tier is the one a caller opts into with `boundRow` (issue #1062).
 * Without it the preview is composition's, where a bound column keeps its
 * braces for the per-row bind; with it the preview is composition *and* that
 * bind, which is what a Send-with-row actually puts on the wire.
 *
 * A `{{$name}}` nothing defines is generated from the dynamic-variable table
 * (`lib/dynamic-variables.ts`) rather than looked up - see `resolveString`.
 *
 * **This is a preview, not the execution path.** Since issue #226 the engine
 * owns execution-time resolution (`POST /compose`); what this hook feeds is
 * display - tab titles, previews, the unresolved-token painting, the "why this
 * value" popover. The substitution rules live in `lib/variable-resolution.ts`
 * and are held to the engine's behaviour by the shared conformance fixture, so
 * the preview cannot quietly drift from what actually gets sent.
 * `getVariableOrigins` keeps the definitions that lost so the UI can explain
 * the winner; execution has no use for losers, so the engine has no analogue.
 */

import { useMemo, useCallback } from "react";
import { useGlobalsQuery, useCollectionsQuery, useEnvironmentsQuery } from "@/queries";
import { useSessionStore } from "@/stores";
import type { VariableValue, ResolvedVariable, VariableOrigin } from "@/types";
import { castByType } from "@/lib/variable-cast";
// The chain this hook used to build itself, guard and all - see tree-utils for
// why every `parentId` walk in the renderer now comes from one place.
import { walkAncestors } from "@/modules/collections/tree-utils";
import {
	coerceVariableValue,
	isEnabledDefinition,
	renderDataValue,
	resolveTemplate,
	resolveTemplateWithRow,
	type DataRowCells,
} from "@/lib/variable-resolution";
import type { DataFileRow } from "@/services/data-files";

interface UseVariableResolverOptions {
	collectionId?: string;
	/**
	 * The data row this preview is bound to, if one is picked (issue #1062).
	 *
	 * Only a Send-with-row has one. Composition never does - a payload is
	 * composed once and a row is bound per iteration - so a caller without one
	 * previews exactly what it always did, and the token a run will bind keeps
	 * its braces. A caller *with* one previews the bind as well as the
	 * composition, which is the whole difference: the row's cell answers a bare
	 * column name above the environment, as it will on the wire.
	 */
	boundRow?: DataFileRow;
}

interface UseVariableResolverReturn {
	resolveString: (input: string) => string;
	resolveObject: <T>(obj: T) => T;
	getVariable: (name: string) => ResolvedVariable | null;
	getAllVariables: () => Record<string, ResolvedVariable>;
	/**
	 * Every definition of a name, lowest precedence first, including the disabled
	 * ones that never resolve. Empty array for a name nothing defines.
	 *
	 * Display-only: nothing about execution reads this. See the note on
	 * `VariableOrigin` for why the losers are worth keeping.
	 */
	getVariableOrigins: (name: string) => VariableOrigin[];
}

export function useVariableResolver(
	options?: UseVariableResolverOptions
): UseVariableResolverReturn {
	const { data: globalsData } = useGlobalsQuery();
	const { data: collections = [] } = useCollectionsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();

	const { activeEnvironmentId } = useSessionStore();
	/*
	 * Collection scope is explicit only. There used to be a session-store
	 * fallback (`activeCollectionId`) for option-less callers, but nothing ever
	 * wrote it - so it could only ever hold a value rehydrated from an old
	 * build, silently scoping resolution to a collection the user had left. An
	 * option-less caller now resolves against globals + environment, which is
	 * what it was already getting on every fresh install.
	 */
	const activeCollectionId = options?.collectionId ?? null;

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
				// D17 (issue #226): a non-string stored value reads as "", and only
				// an explicit `enabled: false` disables - absent counts as enabled,
				// matching the importers and the engine's parse_variables. The
				// preview must agree with what /compose will actually substitute.
				value: coerceVariableValue(v.value),
				secret: v.secret,
				type: v.type,
				enabled: isEnabledDefinition(v),
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
			for (const col of walkAncestors(activeCollectionId, collections)) {
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
			// before. The unresolved-token painting (`VariableInput`, which looks
			// each name up in this map and falls back to the dynamic-variable
			// table) depends on such a name being absent rather than
			// present-and-empty.
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

	/**
	 * The bound row's cells as the text each substitutes, rendered once rather
	 * than per token. Undefined - not an empty map - when no row is bound, so
	 * `resolveString` below can tell "no row" from "a row with no columns".
	 */
	const boundRow = options?.boundRow;
	const rowCells = useMemo<DataRowCells | undefined>(
		() =>
			boundRow
				? new Map(Object.entries(boundRow).map(([column, cell]) => [column, renderDataValue(cell)]))
				: undefined,
		[boundRow]
	);

	/**
	 * Scopes first, then the dynamic-variable table.
	 *
	 * The order is the compatible one: a collection that already defines a
	 * variable literally named `$guid` keeps its value, and only a name nothing
	 * defines reaches a generator. Each generator is called *inside* the replace
	 * callback, so it runs once per occurrence - two `{{$guid}}` in one body are
	 * two different ids, which is the reason to write them.
	 *
	 * An unknown `$name` keeps its braces rather than resolving to "". A typo'd
	 * generator that sent an empty field silently is the defect this table was
	 * added to fix (issue #186); leaving `{{$randomInteger}}` on the wire makes
	 * it visible in the request, and `EditableVariable` keeps painting the token
	 * as unresolved. Since issue #1009 an ordinary unknown name is the same
	 * rule - the preview shows the token the engine will send.
	 *
	 * With a row bound the preview is the bind as well as the composition
	 * (issue #1062): the row's cell answers a bare column name above every
	 * scope, and `{{data.column}}` answers from the same row, because they are
	 * one bind and the send would be a lie about the other one.
	 */
	const resolveString = useCallback(
		(input: string): string =>
			rowCells
				? resolveTemplateWithRow(input, (name) => variableMap[name]?.value, rowCells)
				: resolveTemplate(input, (name) => variableMap[name]?.value),
		[variableMap, rowCells]
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

	return {
		resolveString,
		resolveObject,
		getVariable,
		getAllVariables,
		getVariableOrigins,
	};
}
