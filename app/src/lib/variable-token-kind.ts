/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a `{{token}}` *is*, decided in the order `resolveTemplate` decides it.
 *
 * The reserved namespaces first (`data.*`, then `$vu` / `$iteration`), then a
 * bare name a bound row answers, then the generator table, then the scopes.
 * The order is load-bearing and documented in `docs/app/COMPONENTS.md`: a scope
 * that defines `$guid` wins and takes the editable token, while a variable
 * someone named `data.email` or `$vu` answers for neither the column nor the
 * identity and must not paint as though it had.
 *
 * The decision lives here, apart from any paint, because two surfaces now make
 * it: `VariableInput`'s overlay strip - which owns the DOM tokens over a
 * single-line field - and the Monaco editors, which have no DOM to hang a token
 * on and paint through decorations instead (issue #1220). A second copy of this
 * ladder is exactly the drift this codebase keeps finding: the two would answer
 * "what is this token" differently, and the same `{{name}}` would read as a
 * column in a URL and an undefined variable in the body beneath it.
 *
 * `VariableInput` adopted this module in #1239 (split the decision from the
 * paint), and the ladder now exists only here: its overlay classifies each
 * token before painting it, which is also how its roving strip counts its own
 * stops without reading back the DOM it has just rendered.
 */

import { DYNAMIC_VARIABLES } from "./dynamic-variables";
import { iterationVariable } from "./iteration-variables";
import { isDataVariableName } from "./variable-resolution";
import { castByType } from "./variable-cast";
import {
	describeBareColumnToken,
	describeColumnToken,
	describeDataToken,
	type DataTokenTone,
} from "./data-contract";
import { scopeAnswer, TEMPLATE_IN_SCRIPT_NOTE } from "./referenced-variables";
import type {
	DataContractScope,
	ResolvedVariable,
	ScopeVariableOrigin,
	VariableOrigin,
	VariableScope,
} from "@/types";

/** The generator table by name - the same lookup the overlay strip makes. */
const DYNAMIC_BY_NAME = new Map(DYNAMIC_VARIABLES.map((v) => [v.name, v]));

/**
 * A token nothing here can edit: a namespace the run binds, or a value
 * generated per use. It has a description and a note to show and no popover -
 * there is no stored variable behind it to open.
 */
export interface RuntimeToken {
	state: "runtime";
	tone: DataTokenTone;
	/** First line: what the token stands for. */
	description: string;
	/** Trailing note: when, or against what, it is decided. */
	note: string;
}

/**
 * A token that addresses the scopes: a stored variable, or a name nothing
 * defines. `info` is the winning definition, `null` when the name resolves to
 * nothing - which is what separates the two paints and what decides whether the
 * popover edits or offers to create.
 */
export interface ScopedVariableToken {
	state: "resolved" | "empty" | "undefined";
	info: ResolvedVariable | null;
}

export type VariableTokenKind = RuntimeToken | ScopedVariableToken;

/** What the resolver and the collection chain answer, at the moment of asking. */
export interface VariableTokenContext {
	/** Every name the scopes resolve, as `getAllVariables` returns them. */
	variables: Record<string, ResolvedVariable>;
	/** The data contract in scope, if the collection chain declares one. */
	dataColumns?: DataContractScope | null;
	/**
	 * Every definition of a name, winner and losers alike - needed only for a
	 * script's single-scope accessor read (`ScriptTokenHint`'s `"scope"` case),
	 * which answers from one rung of the ladder rather than the winner across
	 * all of them. Absent for a caller with no such reads to classify (the
	 * existing body-language callers, and `variable-token-kind.test.ts`).
	 */
	getVariableOrigins?: (name: string) => VariableOrigin[];
}

/**
 * How a script's mention of a name should be classified, when that differs
 * from the merged ladder `classifyVariableToken` answers by default.
 *
 * A script reaches a variable through a `pm.<accessor>.get(...)` call, and
 * each accessor reads a different slice of what a body-language `{{name}}`
 * reads in full (issue #1063's vocabulary, `PM_ACCESSORS` in
 * `referenced-variables.ts`):
 *
 * - `"scope"` - one scope's own answer (`pm.environment.get`,
 *   `pm.globals.get`, `pm.collectionVariables.get`), independent of whether a
 *   higher scope also defines the name.
 * - `"row"` - the bound data row and nothing else (`pm.iterationData.get`),
 *   so the answer is a column state, never a scope's.
 * - `"bare"` - not a read at all: a `{{name}}` written into a script outside
 *   any `pm.variables.replaceIn(...)` call, which the engine sends verbatim
 *   (D16, `docs/engine/scripting.md`). Muted and informational regardless of
 *   what the name would otherwise resolve to.
 *
 * `pm.variables.get(...)` (the merged read) and a `replaceIn(...)` template
 * both read the same ladder a body-language token does, so neither carries a
 * hint - `classifyScriptToken` falls through to `classifyVariableToken`.
 */
export type ScriptTokenHint =
	{ via: "scope"; scope: VariableScope } | { via: "row" } | { via: "bare" };

/**
 * The muted, no-edit answer for a script's bare `{{name}}` (issue #1220 script
 * support). One constant because the wording is the chip row's own
 * `TEMPLATE_IN_SCRIPT_NOTE` (issue #1553) - a second copy here is exactly the
 * drift that string's own comment warns about.
 */
const BARE_SCRIPT_TEMPLATE_KIND: RuntimeToken = {
	state: "runtime",
	tone: "muted",
	description: TEMPLATE_IN_SCRIPT_NOTE,
	note: 'Wrap it in pm.variables.replaceIn("...") to interpolate it.',
};

/**
 * A `ScopeVariableOrigin` as the value a reader gets - the same shape
 * `useVariableResolver`'s private `resolvedFrom` builds from the ladder's
 * winner, rebuilt here for one scope's own answer instead. Kept local rather
 * than imported: that helper is not exported, and a `lib/` module reaching
 * into a `hooks/` one would invert the layering the two already have.
 */
function resolvedFromOrigin(origin: ScopeVariableOrigin): ResolvedVariable {
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
 * `classifyVariableToken`, plus the three script-only answers a
 * `ScriptTokenHint` asks for. Every editor's `classify` call goes through this
 * now; a caller with no hint (every body-language token, `pm.variables.get`,
 * and a `replaceIn(...)` template) gets exactly what it always got.
 */
export function classifyScriptToken(
	name: string,
	hint: ScriptTokenHint | undefined,
	context: VariableTokenContext
): VariableTokenKind {
	if (!hint) return classifyVariableToken(name, context);

	if (hint.via === "bare") return BARE_SCRIPT_TEMPLATE_KIND;

	if (hint.via === "row") {
		return { state: "runtime", ...describeColumnToken(name, context.dataColumns ?? null) };
	}

	// hint.via === "scope": this accessor's own rung, never the ladder's winner.
	const origins = context.getVariableOrigins?.(name) ?? [];
	const own = scopeAnswer(origins, hint.scope);
	if (!own) return { state: "undefined", info: null };
	// `scopeAnswer` only ever returns an origin whose `scope` equals the
	// `VariableScope` it was asked for, so it can never be the `"row"` tier
	// `VariableOriginScope` also allows - safe to narrow to `ScopeVariableOrigin`.
	return {
		state: own.value ? "resolved" : "empty",
		info: resolvedFromOrigin(own as ScopeVariableOrigin),
	};
}

/**
 * Classify one `{{name}}`, without the braces.
 *
 * Pure and synchronous: the resolver's own lookups are map reads, so a caller
 * on Monaco's hover or decoration path can ask per token without a cache.
 */
export function classifyVariableToken(
	name: string,
	{ variables, dataColumns }: VariableTokenContext
): VariableTokenKind {
	// The reserved data namespace, read before the scopes: it is disjoint from
	// them, so a variable named `data.email` never answers for the column.
	if (isDataVariableName(name)) {
		return { state: "runtime", ...describeDataToken(name, dataColumns) };
	}

	// The reserved identity namespace, reserved the same way and for the same
	// reason - `lookupVariable` answers `$vu` ahead of every scope.
	const identity = iterationVariable(name);
	if (identity) {
		return {
			state: "runtime",
			tone: "muted",
			description: identity.description,
			note: "not generated here",
		};
	}

	const info = variables[name];

	// A bare name no scope defines, which a bound row's column answers (#1007).
	// A scope that *does* define it keeps painting as that variable.
	if (!info && dataColumns?.columns.includes(name)) {
		return { state: "runtime", ...describeBareColumnToken(dataColumns) };
	}

	// A generator shows through only where nothing defines the name, so the
	// token cannot describe a value the request will not carry.
	const dynamic = !info ? DYNAMIC_BY_NAME.get(name) : undefined;
	if (dynamic) {
		return {
			state: "runtime",
			tone: "muted",
			description: dynamic.description,
			note: "generated per use",
		};
	}

	if (!info) return { state: "undefined", info: null };
	// An empty value is its own state, not a resolved one: it is the reason the
	// request carries nothing where the author expected something.
	return { state: info.value ? "resolved" : "empty", info };
}
