/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Iteration variables, `{{$vu}}` and `{{$iteration}}`.
 *
 * They name a **reserved identity namespace** (#994), like `{{data.*}}` (`DATA_NAMESPACE_PREFIX` in
 * `variable-resolution.ts`) and unlike every entry in `dynamic-variables.ts`, which is why they are
 * a separate table rather than two more rows there:
 *
 * - A `DynamicVariable` has a `generate()` because its value is made *at compose time*, once per
 *   occurrence, wherever it is written.
 * - `{{$vu}}` and `{{$iteration}}` have no compose-time value at all. The number belongs to the
 *   iteration that *sends* the request (which virtual user, which pass through the plan), and only
 *   the engine executor knows it, immediately before each send. Composition (app preview included)
 *   leaves the token as written; binding it earlier would be a fabricated value with no run behind
 *   it.
 *
 * So this table has no `generate`. `isIterationVariableName` is what `variable-resolution.ts` and
 * the autocomplete surfaces use to keep these two out of the ordinary scope lookup and the
 * dynamic-variable table, as `isDataVariableName` keeps `data.*` out of both.
 *
 * Mirrors the engine's reserved set exactly: `vayu::http::is_identity_variable_name`
 * (`engine/src/http/request_composer.cpp`).
 */

/** One reserved identity name: the name as written (with `$`), and what it is. */
export interface IterationVariable {
	/** Name including the leading `$`, e.g. `"$vu"`. */
	name: string;
	/** One line for the autocomplete list - what the value means, and when it is bound. */
	description: string;
}

/**
 * The two names, in the order the autocomplete offers them: the identity
 * (which virtual user) before the position (which pass).
 */
export const ITERATION_VARIABLES: readonly IterationVariable[] = [
	{
		name: "$vu",
		description: "Virtual user number (1-based) - bound per iteration by the run",
	},
	{
		name: "$iteration",
		description: "Iteration number (0-based) - bound per iteration by the run",
	},
] as const;

const BY_NAME = new Map(ITERATION_VARIABLES.map((v) => [v.name, v]));

/**
 * The reserved name `name` addresses, or `undefined`, for a surface that needs the entry rather
 * than the yes/no (`VariableInput`'s token paint). One map behind both, so a surface cannot decide
 * a name is reserved and then fail to find what it says.
 */
export function iterationVariable(name: string): IterationVariable | undefined {
	return BY_NAME.get(name);
}

/** True for exactly `$vu` and `$iteration` - the reserved identity namespace. */
export function isIterationVariableName(name: string): boolean {
	return BY_NAME.has(name);
}
