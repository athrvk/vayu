/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestBreadcrumb - where the open request lives, above the URL bar.
 *
 * Nothing in the builder used to say. The tab strip shows a bare name with no
 * path, so a request opened from a nested folder gave no clue which collection
 * chain it belonged to - and therefore which inherited auth, scripts and
 * variables were about to run with it.
 *
 * **Read-only identity, one line.** Clicking a collection segment opens that
 * collection's tab; the name segment is inert, because you are already there.
 * Renaming happens in the Info tab, which is the one rename surface in the
 * builder - a second one here would be two controls for one act.
 *
 * **It costs nothing when there is nothing to say.** A request with no
 * collection and no name renders no element at all rather than a reserved empty
 * band. That band is exactly what `RequestDescription` charged every request
 * ~30px for, one row below this one, until it became the Info tab.
 *
 * **Ancestors truncate, the name never does.** A deep chain has to give way
 * somewhere, and the name is the part you are looking for: the ancestor row
 * gets `min-w-0` and shrinks, the name is `shrink-0` and does not. The chain
 * itself comes from `useCollectionAncestors`, which carries the cycle guard, and
 * reads the collections query - so a rename or a drag-move updates this from the
 * cache without a refetch.
 */

import { ChevronRight } from "lucide-react";

import { TruncatedText } from "@/components/shared";
import { useCollectionAncestors } from "@/queries/collections";
import { useTabsStore } from "@/stores";
import { useRequestBuilderContext } from "../context";

export default function RequestBreadcrumb() {
	const { request } = useRequestBuilderContext();
	const ancestors = useCollectionAncestors(request.collectionId);
	const openTab = useTabsStore((s) => s.openTab);

	const name = request.name.trim();
	if (ancestors.length === 0 && !name) return null;

	return (
		<nav
			aria-label="Request location"
			className="flex items-center gap-1 min-w-0 overflow-hidden px-3 pt-1.5 text-[11px] text-subtle-foreground bg-panel shrink-0"
		>
			{ancestors.length > 0 && (
				// The shrinking half. `min-w-0` on both this row and each segment is
				// what lets `truncate` engage at all - a flex item defaults to
				// min-content width and simply overflows instead.
				<div className="flex items-center gap-1 min-w-0">
					{ancestors.map((collection) => (
						<span key={collection.id} className="flex items-center gap-1 min-w-0">
							<button
								type="button"
								onClick={() =>
									openTab({ type: "collection", entityId: collection.id })
								}
								className="min-w-0 max-w-[16ch] rounded-sm hover:text-foreground transition-colors"
							>
								<TruncatedText className="block">{collection.name}</TruncatedText>
							</button>
							<ChevronRight
								aria-hidden="true"
								className="size-3 shrink-0 opacity-60"
							/>
						</span>
					))}
				</div>
			)}
			{name && <span className="shrink-0 text-muted-foreground">{name}</span>}
		</nav>
	);
}
