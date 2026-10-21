/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which columns do these requests reference, measured against `columns`
 * (issues #600, #2050). The collecting half of the audit: `auditDataColumns`
 * buckets, this hook gathers what it buckets, the way a run would see it.
 *
 * **What a request sends, not what it holds** (issue #729): a request's
 * `inherit` auth is resolved through its collection chain
 * (`resolveEffectiveAuth`), since a data row binds into the credentials a step
 * presents, and the chain's own scripts are scanned because a run executes them
 * around every step.
 *
 * Which requests are the caller's question, not this hook's: the Data tab
 * audits every collection its contract answers for, a run audits what it runs,
 * and a load run audits the one request it is about to send.
 */

import { useMemo } from "react";

import { useCollectionsQuery, useFullCollectionRequests } from "@/queries";
import { auditDataColumns, type AuditableRequest, type ColumnAudit } from "@/services/data-files";
import { scriptTextFor } from "@/lib/elements";
import { resolveEffectiveAuth } from "@/modules/request-builder/utils/auth-resolution";
import { walkAncestors } from "@/modules/collections/tree-utils";
import type { Collection, Request } from "@/types";

/** A request as stored or drafted: its auth still unresolved. */
export type ColumnAuditRequest = Pick<
	Request,
	"url" | "params" | "headers" | "body" | "elements" | "auth"
>;

/**
 * What to audit.
 *
 * - **Collection ids**: every stored request in each of them, each under its
 *   own collection's chain.
 * - **Explicit requests**: exactly these, under `collectionId`'s chain (`null`
 *   for a request in no collection, which inherits nothing). For a caller that
 *   holds a request the stored rows may not match yet - a draft being sent.
 *
 * Pass a memoised value: it is a dependency of the audit.
 */
export type ColumnAuditSubject =
	string[] | { collectionId: string | null; requests: readonly ColumnAuditRequest[] };

export interface ColumnAuditResult {
	audit: ColumnAudit;
	/** The stored requests are still being fetched; the audit is not final. */
	isLoading: boolean;
}

/** One collection's requests, audited under that collection's chain. */
interface AuditGroup {
	collectionId: string | null;
	requests: readonly ColumnAuditRequest[];
}

const NO_COLLECTIONS: string[] = [];

/**
 * @param subject The requests to audit - see {@link ColumnAuditSubject}.
 * @param columns The columns to audit them against: a contract's, or a file's.
 *        Memoise it too.
 */
export function useColumnAudit(
	subject: ColumnAuditSubject,
	columns: readonly string[]
): ColumnAuditResult {
	const { data: collections = [] } = useCollectionsQuery();
	// Whole rows: the tree's summaries carry none of what a request sends.
	const { requestsByCollection, isLoading } = useFullCollectionRequests(
		"requests" in subject ? NO_COLLECTIONS : subject
	);

	const groups = useMemo<AuditGroup[]>(
		() =>
			"requests" in subject
				? [subject]
				: subject.map((id) => ({
						collectionId: id,
						requests: requestsByCollection.get(id) ?? [],
					})),
		[subject, requestsByCollection]
	);

	const audit = useMemo(() => {
		const requests: AuditableRequest[] = groups.flatMap(({ collectionId, requests }) => {
			// One walk per collection rather than per request: every request in a
			// collection inherits down the same chain.
			const ancestors = collectionId ? walkAncestors(collectionId, collections) : [];
			return requests.map((request) => ({
				...request,
				resolvedAuth: resolveEffectiveAuth(request.auth, ancestors),
			}));
		});
		const collectionScripts = chainCollections(groups, collections).flatMap((collection) => [
			scriptTextFor(collection.elements, "script.pre") ?? "",
			scriptTextFor(collection.elements, "script.post") ?? "",
		]);
		return auditDataColumns(columns, requests, collectionScripts);
	}, [groups, collections, columns]);

	// With explicit requests nothing is fetched, so this is false by construction.
	return { audit, isLoading };
}

/**
 * Every collection whose scripts a run of these requests executes: each
 * audited collection *and its ancestors*, since the chain's scripts run
 * root-to-leaf around every step. Deduplicated by id - a shared ancestor is one
 * collection however many audited children sit under it.
 */
function chainCollections(groups: readonly AuditGroup[], collections: Collection[]): Collection[] {
	const byId = new Map<string, Collection>();
	for (const { collectionId } of groups) {
		if (!collectionId) continue;
		for (const ancestor of walkAncestors(collectionId, collections))
			byId.set(ancestor.id, ancestor);
	}
	return [...byId.values()];
}
