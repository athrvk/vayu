/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Resolves `{{variables}}` in strings against the current variable context (globals, collection
 * chain, active environment), cached per (collectionId, environmentId) via `useMemo`.
 *
 * Priority, highest wins: the bound data row (bare column names, only while one is picked) >
 * environment > collection chain (leaf → root: closer to the leaf overrides closer to the root) >
 * global.
 *
 * The row tier is one a caller opts into with `boundRow` (#1062). Without it the preview is
 * composition's, where a bound column keeps its braces for the per-row bind; with it the preview is
 * composition *and* that bind, which is what a Send-with-row actually puts on the wire.
 *
 * A `{{$name}}` nothing defines is generated from the dynamic-variable table
 * (`lib/dynamic-variables.ts`) rather than looked up; see `resolveString`.
 *
 * **This is a preview, not the execution path.** The engine owns execution-time resolution
 * (`POST /compose`, #226); this hook feeds display: tab titles, previews, the unresolved-token
 * painting, the "why this value" popover. The substitution rules live in
 * `lib/variable-resolution.ts` and are held to the engine's behaviour by the shared conformance
 * fixture, so the preview cannot quietly drift from what actually gets sent. `getVariableOrigins`
 * keeps the definitions that lost so the UI can explain the winner, and the bound row above them
 * (#1064), so its answer is the one the send will use rather than the one the scopes settled on.
 * Execution has no use for losers, so the engine has no analogue.
 */

import { useMemo, useCallback } from "react";
import { useGlobalsQuery, useCollectionsQuery, useEnvironmentsQuery } from "@/queries";
import { useSessionStore } from "@/stores";
import type {
	VariableValue,
	ResolvedVariable,
	VariableOrigin,
	ScopeVariableOrigin,
	VariableScope,
} from "@/types";
import { castByType } from "@/lib/variable-cast";
// See tree-utils for why every `parentId` walk in the renderer comes from one place.
import { walkAncestors } from "@/modules/collections/tree-utils";
import {
	coerceVariableValue,
	dataColumnName,
	isEnabledDefinition,
	previewRowBind,
	renderDataValue,
	resolveStringsDeep,
	resolveTemplate,
	resolveTemplateWithRow,
	type DataRowCells,
} from "@/lib/variable-resolution";
import type { BoundField, DataFieldContext } from "@/lib/data-bind-escaping";
// The single-scope read's own rule, shared with the chip that explains it.
import { scopeAnswer } from "@/lib/referenced-variables";
import type { DataFileRow } from "@/services/data-files";

interface UseVariableResolverOptions {
	collectionId?: string;
	/**
	 * The data row this preview is bound to, if one is picked (#1062). Only a Send-with-row has
	 * one; composition never does (a payload is composed once and a row bound per iteration), so a
	 * caller without one previews exactly what it always did, and the token a run will bind keeps
	 * its braces. A caller *with* one previews the bind as well as the composition: the row's cell
	 * answers a bare column name above the environment, as it will on the wire.
	 */
	boundRow?: DataFileRow;
}

interface UseVariableResolverReturn {
	/**
	 * Resolve one string. `row` is for the caller that resolves for *several*
	 * requests at once and so cannot name one row for the whole hook - the tab
	 * strip, which labels every open tab from a single resolver (issue #1074).
	 * It answers for that call only, and defaults to the `boundRow` option.
	 * `collectionId` likewise scopes that one call to a collection chain, over the
	 * hook's own (issue #3686): a tab titled from its own collection's variables.
	 */
	resolveString: (input: string, row?: DataFileRow, collectionId?: string) => string;
	/**
	 * `resolveString` for a field of a known kind (issue #2639): with a row
	 * bound, a cell is escaped or encoded for @p context as the send's bind
	 * writes it, and `refusals` holds why the send would refuse the row, worded
	 * for a reader who picked it. Without one it is composition's preview, which
	 * writes every value raw whatever the field. `context` defaults to `plain`.
	 */
	resolveField: (input: string, context?: DataFieldContext) => BoundField;
	resolveObject: <T>(obj: T) => T;
	getVariable: (name: string) => ResolvedVariable | null;
	getAllVariables: () => Record<string, ResolvedVariable>;
	/**
	 * What one scope answers on its own: the names it defines through enabled
	 * rows, valued as `pm.<scope>.get` would read them - independent of which
	 * scope wins the whole ladder (issue #1302).
	 *
	 * Display-only, like `getVariableOrigins`. Execution reaches a single scope
	 * through the engine, which walks that scope's own chain for the same reason.
	 */
	getScopeVariables: (scope: VariableScope) => Record<string, ResolvedVariable>;
	/**
	 * Every definition of a name, lowest precedence first, including the disabled
	 * ones that never resolve. Empty array for a name nothing defines.
	 *
	 * Display-only: nothing about execution reads this. See the note on
	 * `VariableOrigin` for why the losers are worth keeping.
	 */
	getVariableOrigins: (name: string) => VariableOrigin[];
}

/** The writable scopes, lowest precedence first. */
const VARIABLE_SCOPES: readonly VariableScope[] = ["global", "collection", "environment"];

/**
 * One definition as the value a reader gets - written once because the ladder's
 * winner and a single scope's own answer are the same shape and must stay so.
 */
function resolvedFrom(origin: ScopeVariableOrigin): ResolvedVariable {
	return {
		value: origin.value,
		scope: origin.scope,
		secret: origin.secret,
		sourceId: origin.sourceId,
		sourceName: origin.sourceName,
		type: origin.type,
		typedValue: castByType(origin.value, origin.type),
	};
}

/**
 * A row as the text each of its cells substitutes - the one place a row is
 * rendered, so the caller-wide row and a per-call one cannot render differently.
 */
function cellsOf(row: DataFileRow): DataRowCells {
	return new Map(Object.entries(row).map(([column, cell]) => [column, renderDataValue(cell)]));
}

/**
 * How a preview's refusal names the bound row. The send's own error says
 * "data row 0", because `POST /execute` binds its one row as row 0 whichever
 * row of the file was picked; a reader who picked row 7 would not recognise it.
 */
const PICKED_ROW_SUBJECT = "the picked row";

/**
 * Every definition of every name for one collection scope, lowest precedence
 * first. Module-level so the hook's own scope and a per-call scope (the tab
 * strip titles many requests from one resolver) are built by one rule.
 */
function buildOrigins(
	globalsData: { variables?: Record<string, unknown> } | undefined,
	collections: ReturnType<typeof useCollectionsQuery>["data"] & object,
	environments: ReturnType<typeof useEnvironmentsQuery>["data"] & object,
	activeCollectionId: string | null,
	activeEnvironmentId: string | null | undefined
): Record<string, ScopeVariableOrigin[]> {
	const result: Record<string, ScopeVariableOrigin[]> = {};

	const push = (
		name: string,
		v: VariableValue,
		scope: VariableScope,
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

	// The winner is the *last enabled* definition.
	for (const list of Object.values(result)) {
		for (let i = list.length - 1; i >= 0; i--) {
			if (list[i].enabled) {
				list[i].winner = true;
				break;
			}
		}
	}

	return result;
}

/**
 * The resolved value per name, derived from the origins so the two cannot
 * disagree about which definition won. A name whose definitions are all
 * disabled is absent, not present-and-empty: the unresolved-token painting
 * (`VariableInput`) depends on it.
 */
function winnersOf(
	originsByName: Record<string, ScopeVariableOrigin[]>
): Record<string, ResolvedVariable> {
	const result: Record<string, ResolvedVariable> = {};
	for (const [name, origins] of Object.entries(originsByName)) {
		const won = origins.find((o) => o.winner);
		if (won) result[name] = resolvedFrom(won);
	}
	return result;
}

export function useVariableResolver(
	options?: UseVariableResolverOptions
): UseVariableResolverReturn {
	const { data: globalsData } = useGlobalsQuery();
	const { data: collections = [] } = useCollectionsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();

	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	/*
	 * Collection scope is explicit only: an option-less caller resolves against globals and the
	 * environment. No session-store fallback: nothing writes one, so it could only hold a value
	 * rehydrated from an old build, silently scoping resolution to a collection the user had left.
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
	const originsByName = useMemo(
		() =>
			buildOrigins(
				globalsData,
				collections,
				environments,
				activeCollectionId,
				activeEnvironmentId
			),
		[globalsData, collections, environments, activeCollectionId, activeEnvironmentId]
	);

	/**
	 * The resolved value per name - derived from the origins rather than built
	 * alongside them, so the two cannot disagree about which definition won.
	 */
	const variableMap = useMemo(() => winnersOf(originsByName), [originsByName]);

	/**
	 * What each scope answers **on its own**: the names it defines through enabled rows, valued as
	 * its own accessor would read them (#1302). A different question from `variableMap`, which is
	 * the point: `pm.collectionVariables.get` reads the collection chain and answers from it
	 * whether or not the environment also defines the name, so a list built by filtering the
	 * ladder's winners hides a collection's own `shop_domain` for no reason the caller can see.
	 * Same origins, same "last enabled wins" rule (`scopeAnswer`, which `describeScopedRead` reads
	 * too), one rung of the ladder instead of all of them.
	 *
	 * A name whose definitions in a scope are all disabled is absent here, for `variableMap`'s
	 * reason: `get` reads enabled rows only, so present-and-empty would offer a name the call
	 * cannot answer.
	 */
	const scopeVariableMaps = useMemo(() => {
		const result: Record<VariableScope, Record<string, ResolvedVariable>> = {
			global: {},
			collection: {},
			environment: {},
		};
		for (const [name, origins] of Object.entries(originsByName)) {
			for (const scope of VARIABLE_SCOPES) {
				const own = scopeAnswer(origins, scope);
				if (own) result[scope][name] = resolvedFrom(own);
			}
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

	const getScopeVariables = useCallback(
		(scope: VariableScope): Record<string, ResolvedVariable> => ({
			...scopeVariableMaps[scope],
		}),
		[scopeVariableMaps]
	);

	/**
	 * The caller-wide bound row's cells as the text each substitutes, rendered
	 * once rather than per token. Undefined - not an empty map - when no row is
	 * bound, so `resolveString` below can tell "no row" from "a row with no
	 * columns".
	 */
	const boundRow = options?.boundRow;
	const rowCells = useMemo<DataRowCells | undefined>(
		() => (boundRow ? cellsOf(boundRow) : undefined),
		[boundRow]
	);

	/**
	 * The scope ladder, plus the bound row on top of it (#1064). The row is layered on *here*
	 * rather than inside `originsByName`, and the split is the point: `originsByName` is what
	 * `variableMap` resolves from, so a row folded into it would make `getAllVariables` report a
	 * row's cell as the variable's value and hand `ResolvedVariable` a scope nobody can write. This
	 * function is display-only, exactly the layer where "what will actually be sent" belongs.
	 *
	 * The row takes `winner` away from every definition beneath it rather than being appended
	 * beside a scope that still claims to have won: two origins flagged as the winner is a list
	 * that cannot be rendered honestly, and `winner` means "what the send will use" to every reader
	 * of it.
	 *
	 * `{{data.column}}` reads the same cell a bare `{{column}}` does, by the column name with the
	 * prefix stripped (`resolveTemplateWithRow`'s rule: they are one bind). `rowCells` is keyed by
	 * bare column names alone, so a lookup by the whole name would never match `data.shop`, and
	 * once a row is bound its hover card would show the declared-column description with no value
	 * beside a bare spelling showing the value the token will send. `originsByName` itself is
	 * unaffected: `data.*` cannot be scope-defined, so `defined` is always empty for it.
	 */
	const getVariableOrigins = useCallback(
		(name: string): VariableOrigin[] => {
			const defined: VariableOrigin[] = originsByName[name] ?? [];
			const column = dataColumnName(name) ?? name;
			// `get`, not a truthiness check: a column whose cell is empty still
			// answers the name, and answers it with "".
			const cell = rowCells?.get(column);
			if (cell === undefined) return defined;
			return [
				...defined.map((o) => ({ ...o, winner: false })),
				{ scope: "row" as const, value: cell, enabled: true, winner: true },
			];
		},
		[originsByName, rowCells]
	);

	/**
	 * Scopes first, then the dynamic-variable table. The compatible order: a collection that
	 * already defines a variable literally named `$guid` keeps its value, and only a name nothing
	 * defines reaches a generator. Each generator is called *inside* the replace callback, so it
	 * runs once per occurrence: two `{{$guid}}` in one body are two different ids, which is the
	 * reason to write them.
	 *
	 * An unknown `$name` keeps its braces rather than resolving to "": a typo'd generator silently
	 * sending an empty field is the defect this table fixes (#186), and leaving
	 * `{{$randomInteger}}` on the wire makes it visible in the request while `EditableVariable`
	 * keeps painting the token as unresolved. An ordinary unknown name follows the same rule
	 * (#1009): the preview shows the token the engine will send.
	 *
	 * With a row bound the preview is the bind as well as the composition (#1062): the row's cell
	 * answers a bare column name above every scope, and `{{data.column}}` answers from the same
	 * row, because they are one bind and the preview would otherwise misreport the other one.
	 */
	const resolveString = useCallback(
		(input: string, row?: DataFileRow, collectionId?: string): string => {
			const scoped =
				collectionId && collectionId !== activeCollectionId
					? winnersOf(
							buildOrigins(
								globalsData,
								collections,
								environments,
								collectionId,
								activeEnvironmentId
							)
						)
					: variableMap;
			const lookup = (name: string) => scoped[name]?.value;
			const cells = row ? cellsOf(row) : rowCells;
			return cells
				? resolveTemplateWithRow(input, lookup, cells)
				: resolveTemplate(input, lookup);
		},
		[
			variableMap,
			rowCells,
			activeCollectionId,
			globalsData,
			collections,
			environments,
			activeEnvironmentId,
		]
	);

	const resolveField = useCallback(
		(input: string, context: DataFieldContext = "plain"): BoundField => {
			const lookup = (name: string) => variableMap[name]?.value;
			return rowCells
				? previewRowBind(input, lookup, rowCells, context, PICKED_ROW_SUBJECT)
				: { text: resolveTemplate(input, lookup), refusals: [] };
		},
		[variableMap, rowCells]
	);

	const resolveObject = useCallback(
		<T>(obj: T): T => resolveStringsDeep(obj, resolveString),
		[resolveString]
	);

	return {
		resolveString,
		resolveField,
		resolveObject,
		getVariable,
		getAllVariables,
		getScopeVariables,
		getVariableOrigins,
	};
}
