/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Spec Queries
 *
 * Reading a bound OpenAPI document, binding one to a collection that already
 * exists, and applying a re-fetched one (issues #637, #638, #655).
 */

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import { boundCollections, type BoundSpec } from "@/services/openapi/bound-spec-match";
import type {
	Collection,
	DeclaredOperation,
	ResponseSchemaIndex,
	SpecDocument,
	SpecOperation,
	SpecSyncRequest,
	SpecSyncResponse,
} from "@/types";

/**
 * The document a collection is bound to, or nothing while it is bound to none.
 *
 * The engine has no metadata-only read, so this pulls `content` too - the whole
 * document, capped engine-side at `maxSpecDocumentBytes`. That is the cost of
 * showing where a binding came from, and it is paid once per spec: the response
 * is immutable (a changed document is a *new* document with a new id), so it is
 * cached indefinitely rather than refetched on every visit to the tab.
 */
export function useSpecQuery(specId: string | null | undefined) {
	return useQuery({
		queryKey: queryKeys.specs.detail(specId ?? ""),
		queryFn: () => apiService.getSpec(specId as string),
		enabled: !!specId,
		staleTime: Infinity,
	});
}

/**
 * Read the document behind every collection's binding (issue #680).
 *
 * A reader rather than a query, because the caller is an event handler: the
 * import dialog asks this once, when Import is pressed, and paying for every
 * bound document merely because someone opened the dialog would fetch whole
 * specs nobody is going to compare. `fetchQuery` on `useSpecQuery`'s own key
 * means the answer is shared with the Spec tab both ways - a document either
 * side has read is already here, and one this reads is there for the tab.
 *
 * A document that cannot be read is left out rather than failing the lookup. A
 * binding whose document the engine no longer has is not a re-import target -
 * there is nothing to sync against - and an import must not be blocked by a
 * check that could not run. A failure that is really the engine being down
 * surfaces on the import itself, which happens next and says so.
 */
export function useBoundSpecReader(): (collections: readonly Collection[]) => Promise<BoundSpec[]> {
	const queryClient = useQueryClient();

	return useCallback(
		async (collections) => {
			const bound = boundCollections(collections);
			// By spec id, not by collection: several collections may bind one
			// document, and that document is one read.
			const documents = new Map<string, Promise<SpecDocument | null>>();
			for (const { specId } of bound) {
				if (documents.has(specId)) continue;
				documents.set(
					specId,
					queryClient
						.fetchQuery({
							queryKey: queryKeys.specs.detail(specId),
							queryFn: () => apiService.getSpec(specId),
							staleTime: Infinity,
						})
						.catch(() => null)
				);
			}
			const read = new Map(
				await Promise.all(
					[...documents].map(
						async ([specId, pending]) => [specId, await pending] as const
					)
				)
			);
			return bound.flatMap((binding) => {
				const document = read.get(binding.specId);
				return document
					? [{ ...binding, sourceUrl: document.sourceUrl, content: document.content }]
					: [];
			});
		},
		[queryClient]
	);
}

/** One request the caller worked out is a given operation - see `matchOperations`. */
export interface SpecOperationStamp {
	requestId: string;
	specOperation: SpecOperation;
}

export interface BindSpecInput {
	collectionId: string;
	/** The document, verbatim. The engine hashes what it stores. */
	content: string;
	/** The URL it was fetched from, or `null` for a file or a paste. */
	sourceUrl?: string | null;
	/** Identity to stamp on the requests that matched. May be empty. */
	stamps: SpecOperationStamp[];
	/**
	 * What the document declares, stored beside it so a run of this collection
	 * can report its contract coverage (issue #629). Absent for a document the
	 * parsers produced no index for, which is stored as "no index".
	 */
	operations?: DeclaredOperation[];
	/**
	 * What the document declares responses look like (issue #628), stored beside
	 * it so a response can be checked against its contract. Absent for a
	 * document that declares none.
	 */
	responseSchemas?: ResponseSchemaIndex;
}

export interface BindSpecResult {
	spec: SpecDocument;
	/** How many requests carry their identity now. */
	stamped: number;
	/**
	 * Requests whose stamp failed, by id. The binding still holds - reported
	 * rather than rolled back, because there is no transaction spanning three
	 * routes and an unstamped request is a request the next bind can stamp.
	 */
	failedStamps: string[];
}

/**
 * Store a document, bind the collection to it, and stamp the matched requests.
 *
 * Three writes in a fixed order, because each depends on the one before: the
 * document has no id until it is stored, the binding is what makes the identity
 * mean anything, and a stamp is per request. The first two failing throws - the
 * bind did not happen. A stamp failing does not: the collection *is* bound, and
 * saying so while naming what did not land is more useful than reporting a
 * failure for a binding the user can see worked.
 *
 * A spec stored by a bind that then failed is left where it is. Documents are
 * not owned by collections (several may bind one), so there is nothing to
 * cascade, and `DELETE /specs/:id` for a document this app may already have
 * bound elsewhere is a worse answer than an unreferenced row.
 */
export function useBindSpecMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({
			collectionId,
			content,
			sourceUrl,
			stamps,
			operations,
			responseSchemas,
		}: BindSpecInput): Promise<BindSpecResult> => {
			const spec = await apiService.createSpec({
				content,
				...(sourceUrl ? { sourceUrl } : {}),
				...(operations && operations.length > 0 ? { operations } : {}),
				...(responseSchemas ? { responseSchemas } : {}),
			});

			await apiService.updateCollection({
				id: collectionId,
				openapi: { specId: spec.id, specHash: spec.hash, syncedAt: Date.now() },
			});

			const results = await Promise.allSettled(
				stamps.map((stamp) =>
					apiService.updateRequest({
						id: stamp.requestId,
						specOperation: stamp.specOperation,
					})
				)
			);
			const failedStamps = stamps
				.filter((_, i) => results[i].status === "rejected")
				.map((stamp) => stamp.requestId);

			return { spec, stamped: stamps.length - failedStamps.length, failedStamps };
		},
		// Settled, not success: a stamp that landed before a later one failed is
		// already on the engine, and the counts the tab shows are read from the
		// request rows. The request lists are invalidated as a family rather than
		// per collection - a spec's operations land across every tag
		// sub-collection, so the affected set is the subtree, not one list.
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
			queryClient.invalidateQueries({ queryKey: queryKeys.requests.all });
		},
	});
}

/**
 * Apply a re-fetched document to the collection bound to it (issue #655).
 *
 * One mutation for one engine call, unlike `useBindSpecMutation`'s three writes:
 * a sync creates, updates and deletes at once, and half of it landing would
 * leave the collection bound to a document its requests do not reflect. The
 * engine refuses that structurally (`POST /specs/sync` is one transaction), so
 * there is nothing here to sequence or to roll back.
 *
 * On success, not settled: a failed sync wrote nothing, so nothing it touched
 * needs refetching. The request lists go as a family - a document's operations
 * land across every tag sub-collection, so the affected set is the subtree - and
 * that also drops the examples a sync refreshed, which are cached under their
 * own request's key.
 */
export function useSyncSpecMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: SpecSyncRequest): Promise<SpecSyncResponse> =>
			apiService.syncSpec(payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
			queryClient.invalidateQueries({ queryKey: queryKeys.requests.all });
		},
	});
}
