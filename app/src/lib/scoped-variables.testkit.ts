/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One fixture, the three views of it `useVariableResolver` hands a caller.
 *
 * The Monaco completion suites stub the resolver out - they are about what a
 * list offers, not about how the ladder is built, which
 * `useVariableResolver.origins.test.tsx` covers against the real queries. What
 * they cannot do is stub the three views *separately*: a scope map that does
 * not agree with the merged map is a state the resolver cannot produce, and a
 * case written against it proves nothing about the app. So a test declares the
 * definitions - what each scope holds, which is what a user edits - and the
 * views are derived here, once (issue #1302).
 */

import type { ResolvedVariable, ScopeVariableOrigin, VariableScope } from "@/types";

/** A definition as a case writes it: the value, plus whatever the case is about. */
export interface StubDefinition {
	value: string;
	secret?: boolean;
	/** Absent counts as enabled, the way a stored definition's flag does (D17). */
	enabled?: boolean;
	sourceId?: string;
	sourceName?: string;
}

/** What each scope defines, keyed by name. A scope may hold one definition per name. */
export type ScopeDefinitions = Partial<Record<VariableScope, Record<string, StubDefinition>>>;

/** Lowest precedence first, the order `useVariableResolver` pushes its origins in. */
const SCOPES: readonly VariableScope[] = ["global", "collection", "environment"];

function resolved(scope: VariableScope, def: StubDefinition): ResolvedVariable {
	return {
		value: def.value,
		scope,
		secret: def.secret,
		sourceId: def.sourceId,
		sourceName: def.sourceName,
	};
}

/** Every definition of one name, lowest precedence first, the disabled ones kept. */
export function stubOrigins(defs: ScopeDefinitions, name: string): ScopeVariableOrigin[] {
	const origins: ScopeVariableOrigin[] = [];
	for (const scope of SCOPES) {
		const def = defs[scope]?.[name];
		if (!def) continue;
		origins.push({
			scope,
			sourceId: def.sourceId,
			sourceName: def.sourceName,
			value: def.value,
			secret: def.secret,
			enabled: def.enabled !== false,
			winner: false,
		});
	}
	// Last enabled wins, exactly as the resolver marks it.
	for (let i = origins.length - 1; i >= 0; i--) {
		if (origins[i].enabled) {
			origins[i].winner = true;
			break;
		}
	}
	return origins;
}

/** What `pm.<scope>.get` reads: that scope's own enabled definitions. */
export function stubScopeVariables(
	defs: ScopeDefinitions,
	scope: VariableScope
): Record<string, ResolvedVariable> {
	const result: Record<string, ResolvedVariable> = {};
	for (const [name, def] of Object.entries(defs[scope] ?? {})) {
		if (def.enabled === false) continue;
		result[name] = resolved(scope, def);
	}
	return result;
}

/** What `{{name}}` and `pm.variables.get` read: the ladder's winner per name. */
export function stubAllVariables(defs: ScopeDefinitions): Record<string, ResolvedVariable> {
	const result: Record<string, ResolvedVariable> = {};
	for (const scope of SCOPES) {
		for (const [name, def] of Object.entries(defs[scope] ?? {})) {
			if (def.enabled === false) continue;
			result[name] = resolved(scope, def);
		}
	}
	return result;
}
