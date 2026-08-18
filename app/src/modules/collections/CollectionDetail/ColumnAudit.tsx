/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Which declared columns do the requests actually use?" - the Data tab's
 * referenced-columns panel (issue #600).
 *
 * The contract and the requests drift apart in both directions and neither is
 * visible until a run: a renamed column leaves `{{data.emial}}` behind, and a
 * column nobody references makes a file wider than it needs to be. The diff
 * beside this one compares the contract to a *file*; this compares it to the
 * requests, which needs no file at all.
 *
 * **Which requests.** Everything the contract answers for - this collection and
 * every descendant down to one that declares its own - because that is the set
 * the chain rule binds (`collectionsUnderContract`). Auditing the leaf alone
 * would call a column unreferenced while a request one level down references
 * it.
 *
 * **Scripts are labeled, never claimed.** `pm.iterationData.get(key)` computes
 * its name at run time, so the scan finds literals only and says so.
 *
 * **What a request sends, not what it holds** (issue #729). Two of the audited
 * surfaces are resolved here rather than read off the row, because the run
 * resolves them the same way: a request's `inherit` auth becomes the chain's
 * credentials (`resolveEffectiveAuth`), which a data row binds per iteration
 * since #591, and the collection chain's own scripts run for every step ahead
 * of the request's. Auditing the rows as stored called a column bound into a
 * basic-auth pair "declared but not referenced".
 */

import { useMemo } from "react";

import { Callout } from "@/components/shared";
import { useCollectionsQuery, useMultipleCollectionRequests } from "@/queries";
import { auditDataColumns, type AuditableRequest } from "@/services/data-files";
import { collectionsUnderContract } from "@/lib/data-contract";
import { resolveEffectiveAuth } from "@/modules/request-builder/utils/auth-resolution";
import { walkAncestors } from "@/modules/collections/tree-utils";
import type { Collection } from "@/types";
import { SectionLabel } from "./shared";

interface ColumnAuditProps {
	/** The collection whose contract is audited. Rendered only when it has one. */
	collection: Collection;
}

/** One column chip, in the tone its bucket carries. */
function ColumnChip({ column, tone }: { column: string; tone: "neutral" | "warning" }) {
	return (
		<code
			className={
				tone === "warning"
					? "rounded-sm bg-warning/10 px-1.5 py-0.5 font-mono text-[11px] text-warning-text"
					: "rounded-sm bg-accent px-1.5 py-0.5 font-mono text-[11px]"
			}
		>
			{column}
		</code>
	);
}

function Bucket({
	label,
	columns,
	tone = "neutral",
}: {
	label: string;
	columns: string[];
	tone?: "neutral" | "warning";
}) {
	if (columns.length === 0) return null;
	return (
		<div className="space-y-1.5">
			<p className="text-xs text-muted-foreground">{label}</p>
			<div className="flex flex-wrap gap-1.5">
				{columns.map((column) => (
					<ColumnChip key={column} column={column} tone={tone} />
				))}
			</div>
		</div>
	);
}

export default function ColumnAudit({ collection }: ColumnAuditProps) {
	// Read from the collection rather than taken as a prop: the caller renders
	// its own list of the same columns just above, and two sources for one list
	// is one list that can disagree with itself.
	const declared = useMemo(() => collection.dataSchema?.columns ?? [], [collection.dataSchema]);
	const { data: collections = [] } = useCollectionsQuery();
	const auditedCollectionIds = useMemo(
		() => collectionsUnderContract(collection.id, collections),
		[collection.id, collections]
	);
	const { requestsByCollection, isLoading } = useMultipleCollectionRequests(auditedCollectionIds);

	/**
	 * Every collection whose scripts a run of these requests executes: each
	 * audited collection *and its ancestors*, since the chain's scripts run
	 * root-to-leaf around every step. Deduplicated by id - a shared ancestor is
	 * one collection however many audited children sit under it.
	 */
	const chainCollections = useMemo(() => {
		const byId = new Map<string, Collection>();
		for (const id of auditedCollectionIds) {
			for (const ancestor of walkAncestors(id, collections)) byId.set(ancestor.id, ancestor);
		}
		return [...byId.values()];
	}, [auditedCollectionIds, collections]);

	const audit = useMemo(() => {
		const requests: AuditableRequest[] = auditedCollectionIds.flatMap((id) => {
			// One walk per collection rather than per request: every request in a
			// collection inherits down the same chain.
			const ancestors = walkAncestors(id, collections);
			return (requestsByCollection.get(id) ?? []).map((request) => ({
				...request,
				resolvedAuth: resolveEffectiveAuth(request.auth, ancestors),
			}));
		});
		const collectionScripts = chainCollections.flatMap((collection) => [
			collection.preRequestScript,
			collection.postRequestScript,
		]);
		return auditDataColumns(declared, requests, collectionScripts);
	}, [auditedCollectionIds, requestsByCollection, declared, collections, chainCollections]);

	return (
		<div>
			<SectionLabel>Referenced columns</SectionLabel>
			<div className="rounded-md border border-rule bg-card surface-card p-3 space-y-3">
				{isLoading ? (
					<p className="text-xs text-muted-foreground">Reading the requests…</p>
				) : (
					<>
						<Bucket label="Declared and referenced" columns={audit.referenced} />
						<Bucket
							label="Referenced but not declared"
							columns={audit.undeclared}
							tone="warning"
						/>
						<Bucket label="Declared but not referenced" columns={audit.unreferenced} />
						{audit.undeclared.length > 0 && (
							<Callout severity="warning" title="Nothing will bind these">
								A run leaves a token naming an undeclared column written as it
								stands unless the file happens to carry the column anyway.
								Re-declare from the file, or fix the token.
							</Callout>
						)}
						<p className="text-[11px] text-muted-foreground">
							{audit.inScripts.length > 0
								? `Scripts also name ${audit.inScripts.join(", ")}. Only literal pm.iterationData.get() arguments are scanned - script usage is dynamic, so this list is best-effort.`
								: "Only literal pm.iterationData.get() arguments are scanned - script usage is dynamic, so this list is best-effort."}
						</p>
					</>
				)}
			</div>
		</div>
	);
}
