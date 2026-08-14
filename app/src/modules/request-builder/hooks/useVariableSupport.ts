/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request builder's own variable scope, in the shape the variable-aware
 * inputs take as a prop.
 *
 * `VariableInput` and `KeyValueEditor` used to reach for
 * `useRequestBuilderContext()` themselves, which is what made them unusable
 * outside this module - the hook throws with no provider above it (#564). They
 * take a `VariableSupport` now, and this is the one adapter from the context to
 * that shape, rather than a `useMemo` copied into each of the five call sites
 * inside the builder.
 *
 * Memoised on the three members: the object is a prop on a `memo`-wrapped row,
 * so a fresh identity each render would re-render every row of the densest
 * table in the app on every keystroke.
 */

import { useMemo } from "react";
import type { VariableSupport } from "@/types";
import { useRequestBuilderContext } from "../context/RequestBuilderContext";

export function useVariableSupport(): VariableSupport {
	const { resolveString, getAllVariables, getVariableOrigins, updateVariable, writableScopes } =
		useRequestBuilderContext();
	return useMemo(
		() => ({
			resolveString,
			getAllVariables,
			getVariableOrigins,
			updateVariable,
			writableScopes,
		}),
		[resolveString, getAllVariables, getVariableOrigins, updateVariable, writableScopes]
	);
}
