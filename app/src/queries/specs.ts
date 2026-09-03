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

import { useCallback, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "./keys";
import { boundCollections, type BoundSpec } from "@/services/openapi/bound-spec-match";
import type {
	Collection,
	ExportFormat,
	Request,
	SpecBindResponse,
	SpecDiffRequest,
	SpecDiffResponse,
	SpecDocument,
	SpecDocumentMeta,
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
 * For the readers that need the text: the bound-spec matching the import dialog
 * does, and nothing else since the export moved engine-side (issue #855 - it
 * reads its own stored bytes). It runs on a user action, which
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
 * Read a stored document's description on demand, without the document.
 *
 * The imperative half of `useSpecMetaQuery`, for the same reason
 * `useSpecContentReader` is one: the caller is an event handler. The Sync
 * section needs `sourceUrl` - where to re-fetch from - at the moment Check is
 * pressed, and since the comparison moved engine-side (issue #854) that is the
 * *only* thing it needs from the stored document. It used to read the bytes
 * here to compare them; the engine reads its own now, so a check of a 12 MB
 * document transfers nothing.
 *
 * Shared cache with the tab's card, which describes the same document, so the
 * click normally costs no request at all.
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

/**
 * What a picked document is, before anything is stored (issue #869).
 *
 * The Spec tab used to answer this itself, by running the import parsers over
 * the picked bytes. The engine reads the same bytes on the bind, so two readers
 * had an opinion about one document and the card could preview a pairing the
 * bind would not commit. `POST /specs/describe` is the same reader the write
 * uses, and what it answers is what the caller hands to `useSpecMatchQuery`
 * below.
 *
 * Keyed by the pick, not by the document: the bytes are not stored and so have
 * no id, and a key holding a 12 MB string would be one copy of the document per
 * cache entry. The caller stamps each picked document with a token, which makes
 * `staleTime: Infinity` honest - a token names one immutable document.
 *
 * `retry: false` because the failures worth showing here are answers about the
 * document - it is not a contract, it is too large, it does not read - and
 * asking again only delays the sentence that says so.
 *
 * @param token `null` while nothing is picked, which disables the query rather
 *        than describing an empty document.
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
 * Which request of this collection is which operation of a document
 * (issue #761).
 *
 * The matching rule is the engine's now (`POST /specs/match`), so this is a
 * read rather than a computation - and a read of two things neither of which is
 * stored: the document is one the user has picked and not yet bound, and the
 * requests are whatever the collection's subtree holds at this moment. Both are
 * therefore in the key, as a fingerprint of exactly what the matcher reads off
 * them, which is what makes `staleTime: Infinity` honest here: an answer cannot
 * go stale while both of its inputs are pinned, and either changing is a
 * different key rather than a refetch of this one.
 *
 * The requests are fingerprinted but not *sent* - the engine gathers the
 * subtree itself, since a spec-bound root usually owns no request directly. The
 * list is passed in because the caller already holds it (it paints the counts
 * beside this), so the fingerprint costs no extra read.
 *
 * @param operations `null` while there is no document to match - a picked file
 *        that did not parse, or nothing picked - which disables the query
 *        rather than asking the engine about an empty document.
 */
export function useSpecMatchQuery(
	collectionId: string,
	requests: readonly Request[],
	operations: SpecOperation[] | null
) {
	const fingerprint = useMemo(() => {
		if (!operations) return "";
		// Every part of an input that changes the answer, and nothing else: a
		// request's id, method and URL decide what it matches, and an operation's
		// identity is what a match carries onto it.
		const requestPart = requests.map((r) => `${r.id} ${r.method} ${r.url}`).join("\n");
		const operationPart = operations
			.map((o) => `${o.operationId ?? ""} ${o.method} ${o.path}`)
			.join("\n");
		return `${requestPart} ${operationPart}`;
	}, [requests, operations]);

	return useQuery({
		queryKey: queryKeys.specs.match(collectionId, fingerprint),
		queryFn: () =>
			apiService.matchSpecOperations({
				collectionId,
				operations: operations as SpecOperation[],
			}),
		enabled: !!collectionId && !!operations,
		staleTime: Infinity,
	});
}

/**
 * The collection, assembled into an OpenAPI document (issue #855).
 *
 * A read, not a mutation, even though it is a POST: nothing is stored, and the
 * dialog toggles between two formats of the same answer, which is exactly what
 * a cache keyed by both is for - the second toggle back is free.
 *
 * **Fresh when you open it, cached while you toggle**, which neither
 * `staleTime` alone can say: `0` re-assembles a 12 MB document every time the
 * format goes back to one already read, and `Infinity` would hand a reopened
 * dialog an export from before the user's last edit. So the moment the dialog
 * mounted is part of the key - the caller mounts this only while the dialog is
 * open, so the mount *is* the reset - and within that reading nothing goes
 * stale.
 *
 * `retry: false` because the two failures worth showing - a binding whose
 * document is not stored, and one that will not read as OpenAPI - are answers
 * rather than transport hiccups, and retrying them only delays the sentence
 * that says so.
 *
 * **The previous answer stays on screen while the next one assembles**
 * (`placeholderData`, issue #1311). Format is part of the key, so switching it
 * is a cache miss, and without a placeholder `data` went undefined for the
 * length of one engine round trip: the dialog's summary card - a bordered block
 * of eight or so lines - was torn down for a one-line spinner and put back,
 * moving both edges of a dialog that centres on itself. What the card states is
 * a property of the collection, not of the serialisation: the counts are the
 * same in JSON and YAML, and only `text` and `fileName` differ. So the honest
 * placeholder is the previous format's answer, and `isFetching` is what the
 * dialog shows while the new one is in flight.
 */
export function useSpecExportQuery(collectionId: string, format: ExportFormat) {
	const [opened] = useState(() => Date.now());
	return useQuery({
		queryKey: queryKeys.specs.export(collectionId, format, opened),
		queryFn: () => apiService.exportSpec({ collectionId, format }),
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
}

/**
 * Bind a collection to an OpenAPI document (issues #638, #862).
 *
 * **One call, one transaction, and no pairing sent.** This used to be three
 * writes made from here - store the document, move the binding, then stamp the
 * requests that matched and clear the ones that no longer did - each of which
 * could land without the next. Both halves of that were bugs before they were
 * rules: a bind that wrote only the matches left every non-matcher carrying
 * identity from the previous document (issue #718), and three writes are three
 * places to stop. `POST /specs/bind` does all of it or none of it, and works
 * the pairing out itself from the bytes it stores - so the identity a request
 * records and the operation index coverage resolves it through come from one
 * read of one document.
 *
 * What stays here is what the user is shown *before* committing:
 * `useSpecMatchQuery` previews the same pairing over the same rule, writing
 * nothing. The bind matches again rather than being handed that preview,
 * because a request may have moved in between - what the two share is the rule,
 * not a result carried between them.
 *
 * Settled rather than success, still: the counts the tab shows are read off the
 * request rows, and a failed bind leaves them where they were - refetching them
 * is how the tab shows that. The request lists go as a family, since a
 * document's operations land across every tag sub-collection.
 */
export function useBindSpecMutation() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			collectionId,
			content,
			sourceUrl,
		}: BindSpecInput): Promise<SpecBindResponse> =>
			apiService.bindSpec({
				collectionId,
				spec: { content, ...(sourceUrl ? { sourceUrl } : {}) },
			}),
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
			queryClient.invalidateQueries({ queryKey: queryKeys.requests.all });
		},
	});
}

/**
 * Ask what a re-fetched document would change (issue #854).
 *
 * A mutation rather than a query although it writes nothing, for the reason
 * `useBindSpecMutation` is one: it runs on a click, once, with an input the
 * user just produced - a re-fetch of a document that may differ every time it is
 * asked for. Caching that under a key would mean fingerprinting the whole
 * document to know when the answer expired, and the answer is wanted *now*
 * rather than kept.
 *
 * Nothing is invalidated on success: the engine stored nothing.
 */
export function useDiffSpecMutation() {
	return useMutation({
		mutationFn: (payload: SpecDiffRequest): Promise<SpecDiffResponse> =>
			apiService.diffSpec(payload),
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
