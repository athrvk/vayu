/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * InheritedElementsNotice (issue #1512)
 *
 * Generalizes `InheritedScriptsNotice` from scripts alone to every element
 * kind. Walks the ancestor chain of the request's collection (root first, via
 * `useCollectionAncestors` - the same hook `AuthInheritBanner` uses for auth)
 * and lists every enabled element a collection in the chain carries - the
 * ones that will run before the request's own. A blank `script.pre`/
 * `script.post` (empty or whitespace-only text) is excluded: it is inert
 * everywhere else (#1609), so counting it here would claim a run that never
 * happens. A disable toggle writes an `inherit.disable` entry into the
 * request's own list rather than editing the ancestor, which the request
 * cannot do.
 *
 * Renders nothing when no collection in the chain carries an element. That is
 * most requests, so it must not leave an empty box behind.
 *
 * `entries` lets a caller supply the resolved list directly instead of
 * reading the live chain - the History run view shows what a stored run
 * recorded, not the live collection chain, which may have changed since.
 */

import { Folder } from "lucide-react";
import { useCollectionAncestors } from "@/queries/collections";
import { Button } from "@/components/ui";
import { isBlankScriptElement } from "@/lib/elements";
import type { Collection, ElementDef, ElementKindSchema, ResolvedElement } from "@/types";
import ChainCard from "./ChainCard";

interface InheritedElementsNoticeProps {
	/** The request's own collection - root of the chain to walk. Ignored when `entries` is passed. */
	collectionId?: string | null;
	/** Elements to render directly, bypassing `useCollectionAncestors` - e.g. from a stored run. */
	entries?: ResolvedElement[];
	/** The request's own elements - read for which ancestor ids are disabled, written to toggle one. */
	ownElements: ElementDef[];
	onChangeOwnElements: (elements: ElementDef[]) => void;
	kinds: ElementKindSchema[];
}

function entriesFromChain(chain: Collection[]): ResolvedElement[] {
	return chain.flatMap((c) =>
		c.elements.map((el) => ({
			...el,
			origin: { kind: "collection" as const, id: c.id, name: c.name },
		}))
	);
}

function disabledIds(ownElements: ElementDef[]): Set<string> {
	const ids = new Set<string>();
	for (const el of ownElements) {
		if (el.kind !== "inherit.disable") continue;
		if (typeof el.config.elementId === "string") ids.add(el.config.elementId);
	}
	return ids;
}

export default function InheritedElementsNotice({
	collectionId,
	entries,
	ownElements,
	onChangeOwnElements,
	kinds,
}: InheritedElementsNoticeProps) {
	// Only resolve the live chain when nothing was supplied - passing `null`
	// when `entries` is present skips the lookup rather than resolving a chain
	// nobody will render.
	const ancestors = useCollectionAncestors(entries ? null : collectionId);
	const source = (entries ?? entriesFromChain(ancestors)).filter(
		(e) =>
			e.enabled &&
			e.kind !== "inherit.disable" &&
			e.origin?.kind === "collection" &&
			!isBlankScriptElement(e)
	);

	if (source.length === 0) return null;

	const disabled = disabledIds(ownElements);

	function toggleDisabled(elementId: string) {
		if (disabled.has(elementId)) {
			onChangeOwnElements(
				ownElements.filter(
					(el) => !(el.kind === "inherit.disable" && el.config.elementId === elementId)
				)
			);
		} else {
			onChangeOwnElements([
				...ownElements,
				{
					id: `el_disable_${elementId}`,
					kind: "inherit.disable",
					enabled: true,
					config: { elementId },
				},
			]);
		}
	}

	const kindLabel = (kind: string) => kinds.find((k) => k.kind === kind)?.label ?? kind;

	return (
		<ChainCard
			caption="Runs before your own"
			summary={
				<p className="m-0 text-xs leading-relaxed text-foreground">
					{source.length === 1 ? "A collection" : `${source.length} elements`} will run
					before your own.
				</p>
			}
		>
			{source.map((entry) => {
				const isDisabled = disabled.has(entry.id);
				return (
					<span key={entry.id} className="flex items-center gap-2 flex-1 min-w-0">
						<Folder className="w-3 h-3 shrink-0 text-primary" />
						<span className="text-[11px] font-mono truncate text-foreground font-semibold">
							{entry.origin?.name}
						</span>
						<span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
							{kindLabel(entry.kind)}
						</span>
						<Button
							variant="link"
							size="sm"
							className="h-auto p-0 text-[11px] ml-auto"
							onClick={() => toggleDisabled(entry.id)}
						>
							{isDisabled ? "Re-enable" : "Disable"}
						</Button>
					</span>
				);
			})}
		</ChainCard>
	);
}
