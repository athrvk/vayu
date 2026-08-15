/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The data contract in scope for a collection - the chain answer, from the
 * cache (issue #600).
 *
 * The walk itself is `resolveDataContract`, which is pure and tested on its
 * own; this is the one adapter from the collections query to it, so the token
 * painter, the two completion providers and the Data tab's audit all read the
 * same object rather than each walking `parentId` themselves.
 *
 * Memoised on the query result and the id: the return value is a prop on
 * `VariableSupport`, which is itself a prop on a `memo`-wrapped key/value row -
 * a fresh object each render would re-render the densest table in the app on
 * every keystroke, which is the reason `useVariableSupport` memoises at all.
 */

import { useMemo } from "react";
import { useCollectionsQuery } from "@/queries";
import { resolveDataContract } from "@/lib/data-contract";
import type { DataContractScope } from "@/types";

export function useDataContract(
	collectionId: string | null | undefined
): DataContractScope | undefined {
	const { data: collections = [] } = useCollectionsQuery();
	return useMemo(
		() => resolveDataContract(collectionId, collections) ?? undefined,
		[collectionId, collections]
	);
}
