/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a collection load run is aimed at, for the header that has no URL to show for it. A
 * request-level run hands the dashboard its method and URL; a collection run has neither, and the
 * store does not say which collection it is. The run's own row does: its snapshot's scenario
 * manifest names the collection and lists the steps, so this reads that row and resolves the name
 * from the collections tree as the history row does (the id stands in once the collection is
 * deleted, never a blank). Primitives out, not an object: the header is memo'd on `Object.is`.
 */

import { useQuery } from "@tanstack/react-query";
import { runDetailOptions, useCollectionName } from "@/queries";
import { scenarioOfSnapshot } from "@/components/layout/context-bar/run-scenario";

export interface CollectionRunTarget {
	collectionName?: string;
	stepCount?: number;
}

export function useCollectionRunTarget(runId: string | null): CollectionRunTarget {
	// The snapshot is written once at run start, so the in-progress poll
	// `runDetailOptions` carries would only re-read what cannot change.
	const { data: run } = useQuery({ ...runDetailOptions(runId), refetchInterval: false });

	const scenario = scenarioOfSnapshot(run?.configSnapshot);
	const collectionName = useCollectionName(scenario?.collectionId);
	if (!collectionName) return {};
	return { collectionName, stepCount: scenario?.steps?.length };
}
