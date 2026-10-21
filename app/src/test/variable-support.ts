/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A variable scope for tests, in the shape the variable-aware inputs take.
 *
 * These used to be `vi.mock("../../context/RequestBuilderContext", ...)` blocks
 * copied into four files - which is why nobody noticed that `VariableInput` and
 * `KeyValueRow` could not render without a `RequestBuilderProvider` at all
 * (#564): every test stood one in.
 *
 * Resolution is deliberately visible - `{{name}}` becomes `resolved-name` - so
 * a test can tell "the scope was used" from "the literal was passed through",
 * which is the whole distinction the prop thread has to keep.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import type { ResolvedVariable, VariableSupport } from "@/types";

type ResolveField = VariableSupport["resolveField"];

const fieldResolvers = new WeakMap<(input: string) => string, ResolveField>();

/**
 * `resolveField` over a test's string resolver, with nothing refused. One per
 * resolver, because the row caches check a resolver by identity and a fresh
 * wrapper per render would redraw what a test counts.
 */
export function fieldResolverOf(resolve: (input: string) => string): ResolveField {
	let resolveField = fieldResolvers.get(resolve);
	if (!resolveField) {
		resolveField = (input) => ({ text: resolve(input), refusals: [] });
		fieldResolvers.set(resolve, resolveField);
	}
	return resolveField;
}

export function variableSupportStub(
	variables: Record<string, ResolvedVariable> = {},
	overrides: Partial<VariableSupport> = {}
): VariableSupport {
	return {
		resolveField: fieldResolverOf((s) =>
			s.replace(VARIABLE_PATTERN, (_m, name) => `resolved-${name}`)
		),
		getAllVariables: () => variables,
		getVariableOrigins: () => [],
		updateVariable: () => {},
		writableScopes: [],
		...overrides,
	};
}
