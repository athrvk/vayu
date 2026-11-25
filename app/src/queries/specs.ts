/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Reading a bound OpenAPI document, binding one to a collection that already exists, and applying a
 * re-fetched one (#637, #638, #655).
 */

import { useCallback, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { invalidateAllRequestLists } from "./collections";
import { queryKeys } from "./keys";
import { boundCollections, type BoundSpec } from "@/services/openapi/bound-spec-match";
import type {
	Collection,
	ExportFormat,
	ExportMode,
	RequestSummary,
	SpecBindResponse,
	SpecDiffRequest,
	SpecDiffResponse,
	SpecDocument,
	SpecDocumentMeta,
	SpecFileLocation,
	SpecOperation,
	SpecSyncRequest,
	SpecSyncResponse,
} from "@/types";

/**
 * The one description of a full-document read, shared by the query and the two readers below. A
 * document is **immutable** (a changed one is a new document with a new id), so every reader wants
 * it cached indefinitely and fetched once. Written once here, because three copies of
 * `staleTime: Infinity` beside three copies of one `queryFn` is how one of them comes to refetch a
 * 12 MB document on a window focus.
 */
function specDocumentQuery(specId: string) {
	return {
		queryKey: queryKeys.specs.detail(specId),
		queryFn: () => apiService.getSpec(specId),
		staleTime: Infinity,
	};
}

/**
 * The whole document a collection is bound to, `content` included, for a reader that needs the
 * text. No component mounts it today: the import dialog's bound-spec matching reads the same key
 * through `useBoundSpecReader`, and the export reads its own stored bytes engine-side (#855). A
 * full read runs on a user action: the Spec tab's card describes the document with
 * `useSpecMetaQuery` below rather than transferring it (#712).
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
 * What the bound document is (where it came from, when, its hash and size) without the document
 * (#712). Those fields live on the document, not on the collection's binding, so painting the Spec
 * tab's source line and date by transferring it cost 12 MB for Stripe's spec and 9.7 MB for
 * GitHub's on every first open; `GET /specs/:id/meta` answers them directly. Cached on the same
 * terms as the document itself, for the same reason: the row it describes cannot change under a
 * given id.
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
 * Read a stored document's text on demand (#712). A reader, not a query, for `useBoundSpecReader`'s
 * reason: the caller is an event handler and wants the bytes at the moment it acts, not after a
 * background transfer. Going through `fetchQuery` on the document's own key (`specDocumentQuery`)
 * means a document already read is answered from cache. No component calls it today: the Sync
 * section compares engine-side (#854) and reads only `sourceUrl`, through `useSpecMetaReader`.
 */
export function useSpecContentReader(): (specId: string) => Promise<SpecDocument> {
	const queryClient = useQueryClient();
	return useCallback(
		(specId) => queryClient.fetchQuery(specDocumentQuery(specId)),
		[queryClient]
	);
}

/**
 * Read a stored document's description on demand, without the document: the imperative half of
 * `useSpecMetaQuery`, because the caller is an event handler. The Sync section needs `sourceUrl`
 * (where to re-fetch from) the moment Check is pressed, and with the comparison engine-side (#854)
 * that is the only thing it needs from the stored document: the engine reads its own bytes to
 * compare them, so a check of a 12 MB document transfers nothing. Shared cache with the tab's card,
 * which describes the same document, so the click normally costs no request at all.
 */
export function useSpecMetaReader(): (specId: string) => Promise<SpecDocumentMeta> {
	const queryClient = useQueryClient();
	return useCallback(
		(specId) =>
			queryClient.fetchQuery({
				queryKey: queryKeys.specs.meta(specId),
				queryFn: () => apiService.getSpecMeta(specId),
				staleTime: Infinity,
			}),
		[queryClient]
	);
}

/**
 * Read the document behind every collection's binding (#680). A reader, not a query, because the
 * caller is an event handler: the import dialog asks once, when Import is pressed, and paying for
 * every bound document merely because someone opened the dialog would fetch whole specs nobody is
 * going to compare. `fetchQuery` on the document's own key (`specDocumentQuery`) answers a document
 * already read from cache, and keeps what it reads there.
 *
 * A document that cannot be read is left out rather than failing the lookup. A binding whose
 * document the engine no longer has is not a re-import target (there is nothing to sync against),
 * and an import must not be blocked by a check that could not run. A failure that is really the
 * engine being down surfaces on the import itself, which happens next and says so.
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

/**
 * What a picked document is, before anything is stored (#869). `POST /specs/describe` is the same
 * reader the bind uses, so the card cannot preview a pairing the bind would not commit, as a second
 * parser of the picked bytes in the Spec tab could; what it answers is what the caller hands to
 * `useSpecMatchQuery` below.
 *
 * Keyed by the pick, not by the document: the bytes are not stored and so have no id, and a key
 * holding a 12 MB string would be one copy of the document per cache entry. The caller stamps each
 * picked document with a token, which makes `staleTime: Infinity` honest: a token names one
 * immutable document.
 *
 * `retry: false` because the failures worth showing here are answers about the document (it is not
 * a contract, it is too large, it does not read), and asking again only delays the sentence that
 * says so.
 *
 * @param token `null` while nothing is picked, which disables the query rather than describing an
 *        empty document.
 */
export function useSpecDescribeQuery(token: string | null, content: string) {
	return useQuery({
		queryKey: queryKeys.specs.describe(token ?? ""),
		queryFn: () => apiService.describeSpec({ content }),
		enabled: !!token,
		staleTime: Infinity,
		retry: false,
	});
}

/**
 * Which request of this collection is which operation of a document (#761). The matching rule is
 * the engine's (`POST /specs/match`), so this is a read, of two things neither of which is stored:
 * a document the user has picked and not yet bound, and whatever the collection's subtree holds at
 * this moment. Both are in the key, as a fingerprint of exactly what the matcher reads off them,
 * which makes `staleTime: Infinity` honest: an answer cannot go stale while both inputs are pinned,
 * and either changing is a different key, not a refetch of this one.
 *
 * The requests are fingerprinted but not sent: the engine gathers the subtree itself, since a
 * spec-bound root usually owns no request directly. The list is passed in because the caller
 * already holds it (it paints the counts beside this), so the fingerprint costs no extra read.
 *
 * @param operations `null` while there is no document to match (a picked file that did not parse,
 *        or nothing picked), which disables the query rather than asking the engine about an empty
 *        document.
 * @param basePaths The document's server base paths, as `POST /specs/describe` answered them
 *        (#3030). They decide which literal-URL requests match, so they are part of the key like
 *        the operations are.
 */
export function useSpecMatchQuery(
	collectionId: string,
	requests: readonly RequestSummary[],
	operations: SpecOperation[] | null,
	basePaths: string[] | null
) {
	const fingerprint = useMemo(() => {
		if (!operations) return "";
		// Every part of an input that changes the answer, and nothing else: a request's id, method
		// and URL decide what it matches, an operation's identity is what a match carries onto it,
		// and the base paths decide which literal-URL requests reach an operation (#3030).
		const requestPart = requests.map((r) => `${r.id} ${r.method} ${r.url}`).join("\n");
		const operationPart = operations
			.map((o) => `${o.operationId ?? ""} ${o.method} ${o.path}`)
			.join("\n");
		const basePathPart = (basePaths ?? []).join("\n");
		return `${requestPart}\u0000${operationPart}\u0000${basePathPart}`;
	}, [requests, operations, basePaths]);

	return useQuery({
		queryKey: queryKeys.specs.match(collectionId, fingerprint),
		queryFn: () =>
			apiService.matchSpecOperations({
				collectionId,
				operations: operations as SpecOperation[],
				basePaths: basePaths ?? undefined,
			}),
		enabled: !!collectionId && !!operations,
		staleTime: Infinity,
	});
}

/**
 * The collection, assembled into an OpenAPI document (#855). A read, not a mutation, though it is a
 * POST: nothing is stored, and the dialog toggles between two formats of one answer, which is
 * exactly what a cache keyed by both is for; the toggle back is free.
 *
 * **Fresh when you open it, cached while you toggle**, which no single `staleTime` can say: `0`
 * re-assembles a 12 MB document every time the format goes back to one already read, and `Infinity`
 * would hand a reopened dialog an export from before the user's last edit. So the moment the dialog
 * mounted is part of the key (the caller mounts this only while the dialog is open, so the mount is
 * the reset), and within that reading nothing goes stale.
 *
 * `retry: false` because the two failures worth showing (a binding whose document is not stored,
 * one that will not read as OpenAPI) are answers rather than transport hiccups, and retrying them
 * only delays the sentence that says so.
 *
 * **The previous answer stays on screen while the next one assembles** (`placeholderData`, #1311).
 * Format is part of the key, so switching it is a cache miss, and without a placeholder `data`
 * would go undefined for one engine round trip: the dialog's summary card (a bordered block of
 * eight or so lines) would be torn down for a one-line spinner and put back, moving both edges of a
 * dialog that centres on itself. What the card states is a property of the collection, not of the
 * serialisation (the counts are the same in JSON and YAML; only `text` and `fileName` differ), so
 * the honest placeholder is the previous format's answer, and `isFetching` is what the dialog shows
 * while the new one is in flight.
 */
export function useSpecExportQuery(
	collectionId: string,
	format: ExportFormat,
	mode: ExportMode = "contract"
) {
	const [opened] = useState(() => Date.now());
	return useQuery({
		queryKey: queryKeys.specs.export(collectionId, format, mode, opened),
		queryFn: () => apiService.exportSpec({ collectionId, format, mode }),
		placeholderData: keepPreviousData,
		staleTime: Infinity,
		retry: false,
	});
}

export interface BindSpecInput {
	collectionId: string;
	/** The document, verbatim. The engine hashes what it stores. */
	content: string;
	/** The URL it was fetched from, or `null` for a file or a paste. */
	sourceUrl?: string | null;
	/**
	 * The picked file the document was read from, or `null` for a URL or a
	 * paste, which also forgets a file bound before (#2765).
	 */
	specFile: SpecFileLocation | null;
}

/**
 * Bind a collection to an OpenAPI document (#638, #862). **One call, one transaction, and no
 * pairing sent**: `POST /specs/bind` stores the document, moves the binding and stamps or clears
 * the matching requests, all of it or none, and works the pairing out itself from the bytes it
 * stores, so the identity a request records and the operation index coverage resolves it through
 * come from one read of one document. Three writes from here could each land without the next, and
 * a bind that wrote only the matches would leave every non-matcher carrying identity from the
 * previous document (#718).
 *
 * What stays here is what the user is shown before committing: `useSpecMatchQuery` previews the
 * same pairing over the same rule, writing nothing. The bind matches again rather than being handed
 * that preview, because a request may have moved in between: what the two share is the rule, not a
 * result carried between them.
 *
 * The one other write is where the picked file is (`specFile` on the collection, #2765), made after
 * the bind lands: it binds no document and stamps no request, so a bind cannot land in halves
 * through it.
 *
 * Settled rather than success: the counts the tab shows are read off the request rows, and a failed
 * bind leaves them where they were, which refetching is how the tab shows. The request lists go as
 * a family, since a document's operations land across every tag sub-collection.
 */
export function useBindSpecMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({
			collectionId,
			content,
			sourceUrl,
			specFile,
		}: BindSpecInput): Promise<SpecBindResponse> => {
			const bound = await apiService.bindSpec({
				collectionId,
				spec: { content, ...(sourceUrl ? { sourceUrl } : {}) },
			});
			// Where the file is, once the document is bound: a path beside an unbound collection
			// names a document nothing compares against. Inside the mutation, not after it, so the
			// collections refetch below reads the file binding instead of racing its write.
			await apiService.updateCollection({ id: collectionId, specFile });
			return bound;
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
			invalidateAllRequestLists(queryClient);
		},
	});
}

/**
 * Ask what a re-fetched document would change (#854). A mutation, not a query, though it writes
 * nothing: it runs on a click, once, with an input the user just produced (a re-fetch of a document
 * that may differ every time). Caching that under a key would mean fingerprinting the whole
 * document to know when the answer expired, and the answer is wanted now, not kept. Nothing is
 * invalidated on success: the engine stored nothing.
 */
export function useDiffSpecMutation() {
	return useMutation({
		mutationFn: (payload: SpecDiffRequest): Promise<SpecDiffResponse> =>
			apiService.diffSpec(payload),
	});
}

/**
 * Apply a re-fetched document to the collection bound to it (#655). One mutation for one engine
 * call: a sync creates, updates and deletes at once, and half of it landing would leave the
 * collection bound to a document its requests do not reflect. The engine refuses that structurally
 * (`POST /specs/sync` is one transaction), so there is nothing here to sequence or roll back.
 *
 * On success, not settled: a failed sync wrote nothing, so nothing it touched needs refetching. The
 * request lists go as a family (a document's operations land across every tag sub-collection, so
 * the affected set is the subtree), which also drops the examples a sync refreshed, cached under
 * their own request's key.
 */
export function useSyncSpecMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: SpecSyncRequest): Promise<SpecSyncResponse> =>
			apiService.syncSpec(payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
			invalidateAllRequestLists(queryClient);
		},
	});
}
