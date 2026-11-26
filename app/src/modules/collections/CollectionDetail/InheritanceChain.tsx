/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The root→leaf ancestor chain of a collection, marking whose auth a descendant request set to
 * `Inherit from collection` would inherit:
 *
 *   - The nearest ancestor (this collection included) that defines auth is the source, unless an
 *     ancestor set to No Auth (`noauth`) blocks inheriting first (see `resolveAuthSource`).
 *   - The current collection is tagged This.
 *   - A request that overrides auth is noted in its row.
 */

import { Folder } from "lucide-react";
import { Badge, Card, Eyebrow } from "@/components/ui";
import { useCollectionAncestors } from "@/queries/collections";
import { AUTH_MODE_LABELS } from "@/constants/auth-modes";
import { cn } from "@/lib/utils";
import {
	isUnsavedAuthDraft,
	resolveAuthSource,
	withDraftAuth,
} from "@/modules/request-builder/utils/auth-resolution";
import type { Collection } from "@/types";

interface InheritanceChainProps {
	collectionId: string;
	/** The Auth tab's live draft, when one is open and dirty - see `withDraftAuth`. */
	draftAuth?: Collection["auth"];
}

/** The "This" / "Source" tag beside a row. `chip` leaves the fill to the caller, with no hover. */
const TAG_CLASS = "text-micro bg-primary-tint text-primary px-1.5 py-px shrink-0";

/**
 * The auth *type*, never its value. This cell is `shrink-0`, meant for a short constant while the
 * row's name yields: a credential here (one imported JWT is several hundred unbreakable mono
 * characters) would push the row past the card's border, scroll the whole tab sideways, and show a
 * bearer token in a summary panel nobody opened to read a secret. The request-side twin
 * (request-builder's AuthInheritBanner) does the same: a bounded type label in the chain row, the
 * credential shown separately and truncated.
 */
function describeAuth(c: Collection): string {
	// A stored mode the registry does not know (a newer engine, a hand-edited
	// file) reads as No Auth rather than printing `undefined`. `noauth` keeps its
	// own registry label because the row exists to show that it blocks inheriting.
	return AUTH_MODE_LABELS[c.auth.mode] ?? AUTH_MODE_LABELS.none;
}

export default function InheritanceChain({ collectionId, draftAuth }: InheritanceChainProps) {
	const rawAncestors = useCollectionAncestors(collectionId);
	const ancestors = withDraftAuth(rawAncestors, collectionId, draftAuth);

	if (ancestors.length === 0) return null;

	// The row for this collection shows the draft; a request below sends the
	// stored row until Save, so that row says so.
	const storedAuth = rawAncestors.find((c) => c.id === collectionId)?.auth;
	const draftIsUnsaved = storedAuth !== undefined && isUnsavedAuthDraft(storedAuth, draftAuth);
	const unsavedMark = (c: Collection) =>
		draftIsUnsaved && c.id === collectionId ? " (unsaved)" : "";

	// Resolution walks leaf → root and picks the nearest collection that defines auth (closer to
	// the leaf wins), stopping at one set to No Auth. Shared with what execution sends, so this
	// panel cannot claim a SOURCE the request would not use.
	const { source, blockedBy } = resolveAuthSource(ancestors);
	const sourceId = source?.id;

	return (
		<Card pad="sm" className="mt-7 px-4">
			{/*
			 * The `Eyebrow` primitive, never a hand-typed copy of its classes: a copy drifts
			 * unseen.
			 */}
			<Eyebrow className="mb-2.5">Inheritance chain</Eyebrow>

			{ancestors.map((c, i) => {
				const isThis = c.id === collectionId;
				const isSource = c.id === sourceId;
				const isLast = i === ancestors.length - 1;
				const indent = i * 14;

				return (
					<div
						key={c.id}
						className={cn(
							"flex items-center gap-2 py-1.5",
							!isLast && "border-b border-rule"
						)}
					>
						<span
							style={{ paddingLeft: indent }}
							className="flex items-center gap-2 flex-1 min-w-0"
						>
							<Folder
								className={cn(
									"size-icon-sm shrink-0",
									isSource ? "text-primary" : "text-muted-foreground"
								)}
							/>
							<span
								className={cn(
									"text-label font-mono truncate",
									isThis
										? "text-foreground font-semibold"
										: "text-muted-foreground"
								)}
							>
								{c.name}
							</span>
						</span>

						<span
							className={cn(
								"text-micro font-mono shrink-0",
								isSource ? "text-primary" : "text-muted-foreground"
							)}
						>
							{describeAuth(c)}
							{unsavedMark(c)}
						</span>

						{isThis && (
							<Badge variant="chip" className={TAG_CLASS}>
								This
							</Badge>
						)}
						{isSource && !isThis && (
							<Badge variant="chip" className={TAG_CLASS}>
								Source
							</Badge>
						)}
					</div>
				);
			})}

			{blockedBy && (
				<p className="mt-2.5 m-0 text-label text-muted-foreground">
					<span className="font-mono">{blockedBy.name}</span> is set to No auth
					{unsavedMark(blockedBy)}, so requests below it inherit nothing.
				</p>
			)}
		</Card>
	);
}
