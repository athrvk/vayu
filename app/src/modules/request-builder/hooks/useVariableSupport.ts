/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The builder's variable scope in the shape variable-aware inputs take as a prop. `VariableInput`
 * and `KeyValueEditor` take a `VariableSupport` rather than call `useRequestBuilderContext()`,
 * which throws without a provider (#564); this is the one adapter, not a `useMemo` copied into each
 * builder call site. Memoised on its members: it is a prop on a `memo` row, and a fresh identity
 * would re-render every row of the densest table per keystroke. `maskSecrets` reads secrets when
 * called, so the memo never holds secret text, and is rebuilt only with `getAllVariables`, which
 * changes with any variable (#1810). Every other member comes off the context, `dataColumns` (#600)
 * and `deferredVariables` (#2741) included: the provider resolves them from data it holds, as a
 * token painter querying the cache would need a `QueryClientProvider` above every `VariableInput`.
 */

import { useMemo } from "react";
import type { VariableSupport } from "@/types";
import { SECRET_UI_MASK, collectSecrets, createSecretMasker } from "@/services/codegen";
import { useRequestBuilderContext } from "../context/RequestBuilderContext";

export function useVariableSupport(): VariableSupport {
	const {
		resolveField,
		getAllVariables,
		getVariableOrigins,
		updateVariable,
		writableScopes,
		dataColumns,
		deferredVariables,
	} = useRequestBuilderContext();
	return useMemo(
		() => ({
			resolveField,
			getAllVariables,
			getVariableOrigins,
			updateVariable,
			writableScopes,
			dataColumns,
			deferredVariables,
			maskSecrets: (text: string) =>
				createSecretMasker(
					collectSecrets(getAllVariables(), undefined),
					true,
					undefined,
					SECRET_UI_MASK
				).apply(text),
		}),
		[
			resolveField,
			getAllVariables,
			getVariableOrigins,
			updateVariable,
			writableScopes,
			dataColumns,
			deferredVariables,
		]
	);
}
