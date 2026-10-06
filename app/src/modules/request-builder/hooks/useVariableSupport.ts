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
 * Memoised on its members: the object is a prop on a `memo`-wrapped row, so a
 * fresh identity each render would re-render every row of the densest table in
 * the app on every keystroke.
 *
 * `maskSecrets` reads the secrets when it is called, not when this memo builds,
 * so the memo never holds secret text; it is rebuilt only with `getAllVariables`,
 * which is what changes when a variable does (#1810).
 *
 * Every other member is read straight off the context, `dataColumns` (the declared
 * data contract, issue #600) included. The provider resolves that one from the
 * collections it already holds rather than this hook querying for it: a token
 * painter that reached for the query cache would need a `QueryClientProvider`
 * above every mount of `VariableInput`, which is the coupling the prop removed.
 */

import { useMemo } from "react";
import type { VariableSupport } from "@/types";
import { SECRET_UI_MASK, collectSecrets, createSecretMasker } from "@/services/codegen";
import { useRequestBuilderContext } from "../context/RequestBuilderContext";

export function useVariableSupport(): VariableSupport {
	const {
		resolveString,
		getAllVariables,
		getVariableOrigins,
		updateVariable,
		writableScopes,
		dataColumns,
	} = useRequestBuilderContext();
	return useMemo(
		() => ({
			resolveString,
			getAllVariables,
			getVariableOrigins,
			updateVariable,
			writableScopes,
			dataColumns,
			maskSecrets: (text: string) =>
				createSecretMasker(
					collectSecrets(getAllVariables(), undefined),
					true,
					undefined,
					SECRET_UI_MASK
				).apply(text),
		}),
		[
			resolveString,
			getAllVariables,
			getVariableOrigins,
			updateVariable,
			writableScopes,
			dataColumns,
		]
	);
}
