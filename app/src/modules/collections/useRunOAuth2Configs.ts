/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMemo } from "react";
import {
	useCollectionsQuery,
	useEnvironmentsQuery,
	useFullCollectionRequests,
	useGlobalsQuery,
} from "@/queries";
import { useSessionStore } from "@/stores";
import type { StoredVariableBag } from "@/lib/variable-resolution";
import type { Collection, Environment } from "@/types";
import { distinctRunOAuth2Configs, type RunOAuth2Config } from "./runOAuth2Configs";

const NO_COLLECTIONS: Collection[] = [];
const NO_ENVIRONMENTS: Environment[] = [];

/**
 * The distinct OAuth 2.0 tokens the stored requests of @p collectionIds send,
 * against the active environment - see {@link distinctRunOAuth2Configs}. Pass
 * an empty list to ask nothing. Memoised: the configs are handed to a guard
 * that re-queries when its config changes identity.
 */
export function useRunOAuth2Configs(collectionIds: string[]): RunOAuth2Config[] {
	const { data: collections = NO_COLLECTIONS } = useCollectionsQuery();
	const { data: globals } = useGlobalsQuery();
	const { data: environments = NO_ENVIRONMENTS } = useEnvironmentsQuery();
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	// Whole rows: the tree's summaries carry no auth.
	const { requestsByCollection } = useFullCollectionRequests(collectionIds);

	return useMemo(() => {
		const environment = environments.find((env) => env.id === activeEnvironmentId);
		return distinctRunOAuth2Configs(
			collectionIds.map((collectionId) => ({
				collectionId,
				requests: requestsByCollection.get(collectionId) ?? [],
			})),
			collections,
			{
				globals: globals?.variables as StoredVariableBag | undefined,
				environment: environment?.variables as StoredVariableBag | undefined,
			}
		);
	}, [
		collectionIds,
		requestsByCollection,
		collections,
		globals,
		environments,
		activeEnvironmentId,
	]);
}
