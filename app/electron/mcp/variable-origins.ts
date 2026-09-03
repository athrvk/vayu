/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file variable-origins.ts
 * @brief The variable resolution model as the MCP surface states it, and which
 *        definition of a name wins (the `resolve_variables` tool's core). The
 *        app answers the second question in the variable popover's origin list;
 *        before this module an agent could not ask it at all, and had to
 *        reconstruct the resolution order from a rule no tool stated
 *        (issue #1207).
 *
 * The prose and the computation live together on purpose: a tool description
 * that paraphrases the order and a resolver that implements it are exactly the
 * two copies that drift. Here the sentence every variable tool carries and the
 * loop that picks the winner are one edit apart.
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
export function collectionChain(rows: readonly CollectionLike[], leafId: string): VariableSource[] {
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
export function reportForName(
	name: string,
	origins: readonly VariableOrigin[]
): ResolvedVariableReport {
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

// --- The model, as the MCP surface states it ---------------------------------

/**
 * The resource that carries the full model. Every variable-writing tool points
 * at this rather than paraphrasing the rules a second time, which is what
 * `tools.test.ts`'s table-driven scan checks.
 */
export const VARIABLE_RESOLUTION_URI = "vayu://variables/resolution";

/**
 * The one sentence. It appears verbatim in every tool that writes or lists
 * variables; a new such tool that omits it fails the scan.
 *
 * Spelled with `<` rather than `>` because that is the direction
 * `docs/app/variable-resolution.md` states the ladder in, and the two spellings
 * in one surface were half of what made the order hard to learn.
 */
export const VARIABLE_PRECEDENCE_SENTENCE =
	"Resolution order (lowest to highest): globals < collection chain (root to leaf) < active environment, with a bound data row's bare column names above all three.";

/**
 * The precedence sentence, this tier's own position in it, and the pointer to
 * the full model - the three things every variable tool's description owes an
 * agent that is about to change a value.
 */
export function precedenceNote(tierPosition: string): string {
	return `${VARIABLE_PRECEDENCE_SENTENCE} ${tierPosition} Full model, including the reserved namespaces and what a script sees: ${VARIABLE_RESOLUTION_URI}.`;
}

/**
 * The rule set from `docs/app/variable-resolution.md`, in the form an agent
 * reads. Structured rather than one prose blob so a client can render or search
 * it, and so the tiers cannot be listed in one order here and another there.
 *
 * This is a statement of a contract the engine executes, not a second
 * implementation of it: nothing here resolves anything. The contract itself is
 * pinned by `engine/tests/fixtures/variable-resolution-conformance.json`, which
 * the engine's suite, the renderer's and this module's conformance guard all
 * replay.
 */
export const VARIABLE_RESOLUTION_MODEL = {
	summary: VARIABLE_PRECEDENCE_SENTENCE,
	resolvedBy:
		"The engine resolves at execution time (POST /compose); the app keeps a preview-only copy of the same rules. Both answer one shared conformance fixture, so what an agent is told here is what a send actually does.",
	tiers: [
		{
			scope: "global",
			rank: 1,
			description:
				"App-wide variables, read by every request whatever environment is active. The base layer - any tier above shadows a global of the same name.",
			writtenBy: ["update_globals"],
			readBy: ["get_globals"],
		},
		{
			scope: "collection",
			rank: 2,
			description:
				"The collection chain, merged root-first so a child collection's variable outranks an ancestor's of the same name. Each collection in the chain is its own definition, not one merged 'collection' value.",
			writtenBy: ["create_collection", "update_collection"],
			readBy: ["list_collections"],
		},
		{
			scope: "environment",
			rank: 3,
			description:
				"The active environment (or whichever environmentId a call names). The intended override point for per-environment values like base URLs and API keys; it beats every collection and global of the same name.",
			writtenBy: ["create_environment", "update_environment", "activate_environment"],
			readBy: ["list_environments"],
		},
		{
			scope: "row",
			rank: 4,
			description:
				"A bound data row's bare column names, and only while a row is bound (a data-driven collection run, a load run given rows, or a send bound to one row). With no dataset the ladder is the three tiers above. A column the row does not carry falls through to the scopes rather than failing.",
			writtenBy: [],
			readBy: [],
		},
	],
	rules: [
		"Only an explicit `enabled: false` disables a definition. Absent or malformed `enabled` counts as enabled.",
		"A non-string stored `value` reads as the empty string rather than being stringified.",
		'A name whose every definition is disabled resolves to nothing at all - it is absent, not present-and-empty, so the placeholder stays unresolved rather than substituting "".',
		"Within one scope the last write wins; across scopes the highest tier that has the name enabled wins.",
		"A disabled definition in a higher tier does not shadow an enabled one beneath it - the lower value is used.",
	],
	reservedNamespaces: [
		{
			pattern: "data.*",
			rule: "`{{data.column}}` addresses a column of a run's data file. It is disjoint from the tiers, not a tier above them: `{{data.id}}` and `{{id}}` are different names, so a data set can neither shadow nor be shadowed by a variable.",
		},
		{
			pattern: "$vu, $iteration",
			rule: "Run identity. Both compose-time resolvers leave them written as they stand and the executor substitutes them immediately before each send, so a variable someone happens to name `$vu` does not answer for the identity.",
		},
		{
			pattern: "$guid, $timestamp, $randomInt, ...",
			rule: "Dynamic generators. Unlike `$vu`, a variable of the same name DOES win over the generator - a scope that defines `$guid` shadows it. `vayu://scripting/completions` carries the full generator list.",
		},
	],
	fromAScript: {
		scoped: "pm.environment.get, pm.collectionVariables.get and pm.globals.get each read one scope only, and answer emptily when that scope has no such name - they do not fall through.",
		merged: "pm.variables.get reads across scopes in this page's order, top down: environment, then the collection chain, then globals, stopping at the first scope that has the name enabled. While a row is bound its bare column names are checked first, above all three.",
		chain: "The collection scope a script reads is the whole chain, the same one {{name}} merges - not just the request's own collection.",
	},
} as const;
