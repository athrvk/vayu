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
 * The one description of a full-document read, shared by the query and the two
 * readers below.
 *
 * A document is **immutable** - a changed one is a new document with a new id -
 * so every reader of it wants the same thing: cached indefinitely, fetched once.
 * Written once here because three copies of `staleTime: Infinity` beside three
 * copies of the same `queryFn` is how one of them comes to refetch a 12 MB
 * document on a window focus.
 */
function specDocumentQuery(specId: string) {
	return {
		queryKey: queryKeys.specs.detail(specId),
		queryFn: () => apiService.getSpec(specId),
		staleTime: Infinity,
	};
}

/**
 * The whole document a collection is bound to - `content` included.
 *
 * For the readers that need the text: export (`useOpenApiExportSource`) and the
 * bound-spec matching the import dialog does. Both run on a user action, which
 * is the rule this read follows - the Spec tab's card describes the document
 * with `useSpecMetaQuery` below rather than transferring it (issue #712).
 */
export function useSpecQuery(specId: string | null | undefined) {
	return useQuery({
		// `""` for a collection that binds nothing, so the disabled query has one
		// key rather than one per falsy spelling.
		...specDocumentQuery(specId ?? ""),
		enabled: !!specId,
	});
}

/**
 * What the bound document *is* - where it came from, when, its hash and size -
 * without the document (issue #712).
 *
 * Opening the Spec tab used to transfer the whole stored document to paint a
 * source line and a date: 12 MB for Stripe's spec, 9.7 MB for GitHub's, on
 * every first open, because those two fields live on the document rather than
 * on the collection's binding. `GET /specs/:id/meta` answers them directly.
 *
 * Cached on the same terms as the document itself, and for the same reason: the
 * row it describes cannot change under a given id.
 */
export function useSpecMetaQuery(specId: string | null | undefined) {
	return useQuery({
		queryKey: queryKeys.specs.meta(specId ?? ""),
		queryFn: () => apiService.getSpecMeta(specId as string),
		enabled: !!specId,
		staleTime: Infinity,
	});
}

/**
 * Read a stored document's text on demand (issue #712).
 *
 * A reader rather than a query, for `useBoundSpecReader`'s reason: the caller is
 * an event handler. The Sync section needs the bound bytes to compare a
 * re-fetched document against, and needs them *when Check is pressed* - holding
 * the button hostage to a background transfer is what this replaced. Going
 * through `fetchQuery` on the document's own key means a document the tab, the
 * export dialog or the import dialog has already read is answered from cache.
 */
export function useSpecContentReader(): (specId: string) => Promise<SpecDocument> {
	const queryClient = useQueryClient();
	return useCallback(
		(specId) => queryClient.fetchQuery(specDocumentQuery(specId)),
		[queryClient]
	);
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
					queryClient.fetchQuery(specDocumentQuery(specId)).catch(() => null)
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
	 * Requests whose recorded identity must be *cleared*, by id (issue #718).
	 *
	 * The other half of stamping, and required rather than optional because a
	 * caller that forgets it leaves the bug this exists for: nothing else in the
	 * app ever writes `null` here, so a request stamped against a document this
	 * collection is no longer bound to keeps that stamp forever - and coverage
	 * resolves a stamp by `operationId` first, so one whose id happens to exist
	 * in the new document claims the wrong operation rather than none.
	 */
	clearStamps: string[];
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
	/**
	 * Requests whose *clear* failed, by id - reported for the same reason and
	 * separately, because the state it leaves is the worse of the two: a stamp
	 * naming an operation of a document this collection is not bound to, which
	 * reads as identity rather than as a gap.
	 */
	failedClears: string[];
}

/**
 * Store a document, bind the collection to it, and make every request's
 * recorded identity agree with what it matched.
 *
 * Three writes in a fixed order, because each depends on the one before: the
 * document has no id until it is stored, the binding is what makes the identity
 * mean anything, and a stamp is per request. The first two failing throws - the
 * bind did not happen. A stamp failing does not: the collection *is* bound, and
 * saying so while naming what did not land is more useful than reporting a
 * failure for a binding the user can see worked.
 *
 * **The third write goes both ways** (issue #718). A bind used to write only
 * the matches, which held while a collection was bound once and never again -
 * but re-binding to a *different* document stamps the requests that match it
 * and says nothing about the rest, so every non-matcher kept identity from the
 * old document. The invariant now is one sentence: after a bind, a request's
 * `specOperation` is the operation it matched in the bound document, or
 * nothing. That the two sets are disjoint is what lets both batches go at once.
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
			clearStamps,
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

			// `null`, not an absent key: the engine reads absent as "keep" and
			// null as "reset to the default", and the default is no operation.
			// The same rule an unbind follows for the collection binding, which
			// is why stamping and un-stamping are one verb rather than two.
			const writes = [
				...stamps.map((stamp) => ({
					requestId: stamp.requestId,
					specOperation: stamp.specOperation as SpecOperation | null,
				})),
				...clearStamps.map((requestId) => ({ requestId, specOperation: null })),
			];
			const results = await Promise.allSettled(
				writes.map((write) =>
					apiService.updateRequest({
						id: write.requestId,
						specOperation: write.specOperation,
					})
				)
			);
			const rejected = new Set(
				writes.filter((_, i) => results[i].status === "rejected").map((w) => w.requestId)
			);
			const failedStamps = stamps
				.map((stamp) => stamp.requestId)
				.filter((id) => rejected.has(id));
			const failedClears = clearStamps.filter((id) => rejected.has(id));

			return {
				spec,
				stamped: stamps.length - failedStamps.length,
				failedStamps,
				failedClears,
			};
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
