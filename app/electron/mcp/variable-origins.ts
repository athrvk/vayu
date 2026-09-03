/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file variable-origins.ts
 * @brief Which definition of a variable name wins, and which ones it beat (the
 *        `resolve_variables` tool's core). The app answers this in the variable
 *        popover's origin list; before this module an agent could not ask it at
 *        all, and had to reconstruct the resolution order from a rule no tool
 *        stated (issue #1207).
 *
 * The order is the one `docs/app/variable-resolution.md` defines and the engine
 * executes: globals < collection chain (root -> leaf) < active environment.
 * Disabled definitions are collected rather than skipped - "why is this not the
 * value I set?" is answered by a switched-off row far more often than by
 * shadowing, and a list built by skipping them cannot say so.
 *
 * **Mirrored by `app/src/lib/variable-resolution.ts` (the winner) and
 * `app/src/hooks/useVariableResolver.ts` (the origin accumulation).** Neither
 * process can import the other's source: this project emits with
 * `rootDir: "electron"` and so cannot compile a file from `src/` (TS6059), and
 * the renderer cannot import one from here either, because this is a referenced
 * composite project (TS6305 - and excluding a file from it to dodge that is
 * TS6307). So the copy is deliberate, the way `compare.ts` mirrors
 * `src/lib/run-compare.ts`, and `variable-origins.conformance.test.ts` runs this
 * winner against the renderer's over the engine's own conformance fixture and
 * fails on any divergence. Change this file and change those two.
 *
 * What this deliberately does NOT do is substitute `{{tokens}}`: that is
 * composition, the engine owns it (`POST /compose`), and MCP keeps no copy of
 * it. This module reports where a value came from; it never renders a request.
 */

/** The three scopes a stored definition can live in, lowest precedence first. */
export type VariableScope = "global" | "collection" | "environment";

/** A stored variable definition as it may actually arrive off disk - loose. */
export interface StoredVariableLike {
	value?: unknown;
	enabled?: unknown;
	secret?: unknown;
	type?: unknown;
}

/** `Record<name, definition>` - the shape of every stored `variables` blob. */
export type StoredVariableBag = Record<string, StoredVariableLike>;

/** A named holder of a variable bag - one collection in the chain, or the environment. */
export interface VariableSource {
	id?: string;
	name?: string;
	variables?: StoredVariableBag;
}

/**
 * The scopes to resolve across. `chain` is **root-first**, so a later (leaf)
 * entry outranks an earlier (root) one - the same order the renderer's
 * `walkAncestors` produces and the engine walks.
 */
export interface OriginScopes {
	globals?: StoredVariableBag;
	chain?: readonly VariableSource[];
	environment?: VariableSource;
}

/**
 * One definition of one name, and whether it is the one a send would use.
 *
 * `winner` is marked rather than inferred by position: once disabled
 * definitions are in the list, "last" and "wins" are different things.
 */
export interface VariableOrigin {
	scope: VariableScope;
	sourceId?: string;
	sourceName?: string;
	value: string;
	secret?: boolean;
	type?: string;
	enabled: boolean;
	winner: boolean;
}

/**
 * D17: only an explicit `false` disables a definition. Absent (a blob written
 * by the raw engine API) and malformed values count as enabled, matching the
 * importers' normalization and the engine's `parse_variables`.
 */
export function isEnabledDefinition(def: StoredVariableLike | undefined): boolean {
	return !!def && typeof def === "object" && def.enabled !== false;
}

/**
 * D17: the raw stored string substitutes; a non-string stored `value` reads as
 * "" rather than being stringified.
 */
export function coerceVariableValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The optional `type` hint, kept only when it is actually a string. */
function coerceVariableType(type: unknown): string | undefined {
	return typeof type === "string" ? type : undefined;
}

/**
 * Every definition of every name, in precedence order (lowest first), with the
 * winner marked.
 *
 * Each collection in the chain is its own origin: two collections in one chain
 * both have scope `"collection"`, and collapsing them by scope would hide the
 * override that actually happened.
 */
export function buildVariableOrigins(scopes: OriginScopes): Record<string, VariableOrigin[]> {
	const result: Record<string, VariableOrigin[]> = {};

	const push = (scope: VariableScope, source: VariableSource | undefined, bag: unknown) => {
		if (!bag || typeof bag !== "object") return;
		for (const [name, def] of Object.entries(bag as StoredVariableBag)) {
			if (!def || typeof def !== "object") continue;
			(result[name] ??= []).push({
				scope,
				...(source?.id !== undefined ? { sourceId: source.id } : {}),
				...(source?.name !== undefined ? { sourceName: source.name } : {}),
				value: coerceVariableValue(def.value),
				...(def.secret === true ? { secret: true } : {}),
				...(coerceVariableType(def.type) !== undefined
					? { type: coerceVariableType(def.type) }
					: {}),
				enabled: isEnabledDefinition(def),
				// Filled in below, once the whole list for this name exists.
				winner: false,
			});
		}
	};

	push("global", undefined, scopes.globals); // 1. globals (lowest)
	for (const col of scopes.chain ?? []) push("collection", col, col.variables); // 2. chain root->leaf
	if (scopes.environment) push("environment", scopes.environment, scopes.environment.variables); // 3. environment (highest)

	// The winner is the *last enabled* definition - which is exactly the value
	// the renderer's overwrite-as-you-go `buildVariableValues` arrives at.
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

/** A collection row as the engine's `GET /collections` answers it. */
export interface CollectionLike {
	id?: unknown;
	name?: unknown;
	parentId?: unknown;
	variables?: unknown;
}

/**
 * The collection chain from the root down to `leafId`, root-first.
 *
 * Root is spelled three ways in stored rows (`null`, absent, `""`), and a
 * corrupted `parentId` can point at itself or close a loop - so the walk is
 * guarded, the way the renderer's `walkAncestors` and the tool layer's
 * descendant walk both are. An unknown id yields an empty chain rather than
 * throwing: whether that is an error is the caller's to decide, because
 * `resolve_variables` refuses it and other callers may not.
 */
export function collectionChain(
	rows: readonly CollectionLike[],
	leafId: string
): VariableSource[] {
	const byId = new Map<string, CollectionLike>();
	for (const row of rows) {
		if (typeof row?.id === "string") byId.set(row.id, row);
	}

	const chain: VariableSource[] = [];
	const seen = new Set<string>();
	let currentId: string | null = leafId;
	while (currentId) {
		if (seen.has(currentId)) break;
		seen.add(currentId);
		const row = byId.get(currentId);
		if (!row) break;
		chain.unshift({
			id: typeof row.id === "string" ? row.id : undefined,
			name: typeof row.name === "string" ? row.name : undefined,
			variables:
				row.variables && typeof row.variables === "object"
					? (row.variables as StoredVariableBag)
					: undefined,
		});
		currentId = typeof row.parentId === "string" && row.parentId !== "" ? row.parentId : null;
	}
	return chain;
}

/** Why a definition is not the one a send would use. */
export type ShadowReason = "outranked" | "disabled";

/** A definition that lost, and which of the two ways it lost. */
export interface ShadowedDefinition {
	scope: VariableScope;
	sourceId?: string;
	sourceName?: string;
	value?: string;
	valueWithheld?: true;
	secret?: boolean;
	enabled: boolean;
	reason: ShadowReason;
}

/** One name's answer: what wins, and everything it beat. */
export interface ResolvedVariableReport {
	name: string;
	/** False when every definition is switched off - the name resolves to nothing. */
	resolved: boolean;
	value?: string;
	valueWithheld?: true;
	scope?: VariableScope;
	sourceId?: string;
	sourceName?: string;
	secret?: boolean;
	type?: string;
	/** Highest precedence first - reading down is reading the order they were rejected in. */
	shadowedBy: ShadowedDefinition[];
}

/**
 * A secret's value is withheld rather than silently dropped, the way
 * `projectOAuth2Token` withholds an access token: `valueWithheld` is stated, so
 * an absent `value` is never mistaken for an empty one.
 *
 * This masks what *this tool* reports. `list_environments`, `get_globals` and
 * `vayu://environments` still answer every value in full - a recorded pre-1.0
 * item this issue did not change - so masking here is consistency with the app's
 * popover, not a security boundary. The tool's description says so.
 */
function withValue(
	value: string,
	secret: boolean | undefined
): { value: string } | { valueWithheld: true } {
	return secret ? { valueWithheld: true } : { value };
}

/**
 * Turn one name's origin list into the winner-plus-shadowed answer, ordered the
 * way the app's popover orders it: highest precedence first.
 *
 * A name whose every definition is disabled reports `resolved: false` with no
 * value - absent, not present-and-empty, because a present-and-empty answer
 * would read as "it resolves to the empty string", which is a different fact.
 */
export function reportForName(name: string, origins: readonly VariableOrigin[]): ResolvedVariableReport {
	const winner = origins.find((o) => o.winner);
	const ranked = [...origins].reverse();
	const shadowedBy: ShadowedDefinition[] = ranked
		.filter((o) => !o.winner)
		.map((o) => ({
			scope: o.scope,
			...(o.sourceId !== undefined ? { sourceId: o.sourceId } : {}),
			...(o.sourceName !== undefined ? { sourceName: o.sourceName } : {}),
			...withValue(o.value, o.secret),
			...(o.secret === true ? { secret: true } : {}),
			enabled: o.enabled,
			reason: o.enabled ? ("outranked" as const) : ("disabled" as const),
		}));

	if (!winner) return { name, resolved: false, shadowedBy };

	return {
		name,
		resolved: true,
		...withValue(winner.value, winner.secret),
		scope: winner.scope,
		...(winner.sourceId !== undefined ? { sourceId: winner.sourceId } : {}),
		...(winner.sourceName !== undefined ? { sourceName: winner.sourceName } : {}),
		...(winner.secret === true ? { secret: true } : {}),
		...(winner.type !== undefined ? { type: winner.type } : {}),
		shadowedBy,
	};
}

/**
 * Every name defined anywhere in `scopes`, reported winner-first and sorted by
 * name so two calls over the same data read the same way.
 *
 * `names`, when given, selects: a name nothing defines still gets a row, with
 * `resolved: false` and an empty `shadowedBy`, because "nothing defines it" is
 * the answer to the question asked and an omitted row is not.
 */
export function resolveVariableReports(
	scopes: OriginScopes,
	names?: readonly string[]
): ResolvedVariableReport[] {
	const origins = buildVariableOrigins(scopes);
	const wanted = names && names.length > 0 ? [...new Set(names)] : Object.keys(origins).sort();
	return wanted.map((name) => reportForName(name, origins[name] ?? []));
}
