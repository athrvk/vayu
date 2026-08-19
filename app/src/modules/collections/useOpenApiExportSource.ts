/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Everything an OpenAPI export reads, gathered from the engine (issue #630).
 *
 * Three reads, and the export cannot start until all three are in: the whole
 * subtree's requests (an OpenAPI import files them under one sub-collection per
 * tag, so a bound root usually owns none directly - the same reason the Spec tab
 * counts the subtree), every request's stored examples, and, for a bound
 * collection, the document itself.
 *
 * Examples are one query per request rather than one bulk read, because the
 * engine offers no bulk route and inventing a client-side fan-in over a route
 * that does not exist would be a guess at a shape. They are the *same* queries
 * the Examples tab uses, under the same keys, so a request whose examples are
 * already on screen costs nothing here.
 *
 * A missing example list is not the same as an empty one, which is why
 * `isLoading` covers them: exporting while they load would write a document
 * whose operations document no responses, and the user would have no way to
 * tell that from an API nobody saved a response for.
 *
 * **The subtree stops where another document begins** (issue #721). Collections
 * re-parent freely, so a collection bound to spec B can sit under one bound to
 * spec A. B's requests carry operation stamps of B, and `patchBoundDocument`
 * matches a stamp by operationId, then by method+path - names generators hand
 * out in every document (`listUsers`, `GET /users`) - so without a boundary B's
 * rows claim A's operations and rewrite them with B's values. The walk therefore
 * refuses to descend into a collection bound to a *different* document, the same
 * predicate `collectionsUnderContract` uses to stop at a sub-collection that
 * declares its own data contract.
 */

import { useCallback, useMemo } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";

import { apiService } from "@/services/api";
import { queryKeys } from "@/queries/keys";
import { useCollectionsQuery, useMultipleCollectionRequests } from "@/queries/collections";
import { useSpecQuery } from "@/queries/specs";
import { collectSubtreeIds } from "@/modules/collections/tree-utils";
import type { ExportRequest } from "@/services/exporters/openapi";
import { hasSpecBinding, type Collection, type RequestExample } from "@/types";

export interface OpenApiExportSource {
	/** Every request beneath the collection, in tree order, with its examples. */
	requests: ExportRequest[];
	/** The bound document as stored, or `undefined` for a collection bound to none. */
	specContent: string | undefined;
	isLoading: boolean;
	/** The collection claims a binding whose document the engine would not give up. */
	specFailed: boolean;
}

export function useOpenApiExportSource(collection: Collection): OpenApiExportSource {
	const { data: collections = [] } = useCollectionsQuery();
	const exportedSpecId = collection.openapi?.specId;
	const subtreeIds = useMemo(
		() =>
			collectSubtreeIds(
				collection.id,
				collections,
				(child) => !bindsAnotherDocument(child, exportedSpecId)
			),
		[collection.id, collections, exportedSpecId]
	);
	const { requestsByCollection, isLoading: requestsLoading } =
		useMultipleCollectionRequests(subtreeIds);

	const requests = useMemo(
		() => subtreeIds.flatMap((id) => requestsByCollection.get(id) ?? []),
		[subtreeIds, requestsByCollection]
	);
	const requestIds = requests.map((request) => request.id);
	const idsKey = requestIds.join(",");
	// Pinned to its contents, the way `useMultipleCollectionRequests` pins its
	// own id list: the array is rebuilt on every render, and the query list below
	// must not be.
	// eslint-disable-next-line react-hooks/exhaustive-deps -- `idsKey` is the contents of `requestIds`
	const stableRequestIds = useMemo(() => requestIds, [idsKey]);

	// The `combine` identity rule `useMultipleCollectionRequests` documents: an
	// inline arrow re-runs the fan-in on every render, because TanStack compares
	// this function by reference before it decides whether to reuse the result.
	const combine = useCallback(
		(results: Array<UseQueryResult<RequestExample[]>>) => ({
			examples: results.map((result) => result.data ?? []),
			isLoading: results.some((result) => result.isLoading),
		}),
		[]
	);
	const exampleQueryOptions = useMemo(
		() =>
			stableRequestIds.map((id) => ({
				queryKey: queryKeys.requests.examples(id),
				queryFn: () => apiService.listRequestExamples(id),
			})),
		[stableRequestIds]
	);
	const exampleQueries = useQueries({ queries: exampleQueryOptions, combine });

	const binding = collection.openapi;
	const bound = hasSpecBinding(binding);
	const spec = useSpecQuery(binding?.specId);

	const exportRequests = useMemo(
		() =>
			requests.map((request, index) => ({
				request,
				examples: exampleQueries.examples[index] ?? [],
			})),
		[requests, exampleQueries.examples]
	);

	return {
		requests: exportRequests,
		specContent: bound ? spec.data?.content : undefined,
		isLoading: requestsLoading || exampleQueries.isLoading || (bound && spec.isLoading),
		specFailed: bound && spec.isError,
	};
}

/**
 * Whether this collection answers to a document other than the one being
 * exported.
 *
 * *Another* document, not *a* document: a descendant bound to the same spec as
 * the root describes the very operations being patched, and excluding it would
 * have the export remove them as operations "nothing here claims" - trading a
 * cross-document rewrite for a silent deletion. A skeleton export (no
 * `exportedSpecId`) has no document of its own, so every binding below it is
 * another one.
 */
function bindsAnotherDocument(collection: Collection, exportedSpecId: string | undefined): boolean {
	return hasSpecBinding(collection.openapi) && collection.openapi?.specId !== exportedSpecId;
}
