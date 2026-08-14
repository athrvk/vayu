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

export function variableSupportStub(
	variables: Record<string, ResolvedVariable> = {},
	overrides: Partial<VariableSupport> = {}
): VariableSupport {
	return {
		resolveString: (s) => s.replace(VARIABLE_PATTERN, (_m, name) => `resolved-${name}`),
		getAllVariables: () => variables,
		getVariableOrigins: () => [],
		updateVariable: () => {},
		writableScopes: [],
		...overrides,
	};
}
