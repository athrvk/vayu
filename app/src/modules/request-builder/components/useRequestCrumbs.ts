/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the open request lives, as crumbs for `TabBreadcrumb`.
 *
 * This was `RequestBreadcrumb`, a component of its own, until the same line was
 * wanted on the collection, run-report and dashboard tabs (#1691). What is
 * builder-specific is only the chain: the collection ancestors, then the
 * request's own name. Drawing it is `TabBreadcrumb`'s job now, so the knowledge
 * that a request sits under a collection stays in this module and the shape of
 * a crumb row is defined once for the whole app.
 *
 * The chain comes from `useCollectionAncestors`, which carries the cycle guard
 * and reads the collections query - so a rename or a drag-move updates the line
 * from the cache without a refetch. Clicking a collection crumb opens that
 * collection's tab; the request's own crumb is inert, because you are already
 * there, and renaming is the Info tab's job - the one rename surface in the
 * builder.
 */

import { useMemo } from "react";

import type { BreadcrumbCrumb } from "@/components/shared";
import { useCollectionAncestors } from "@/queries/collections";
import { useTabsStore } from "@/stores";
import { useRequestBuilderContext } from "../context";

export function useRequestCrumbs(): BreadcrumbCrumb[] {
	const { request } = useRequestBuilderContext();
	const ancestors = useCollectionAncestors(request.collectionId);
	const openTab = useTabsStore((s) => s.openTab);
	const name = request.name.trim();

	return useMemo(
		() => [
			...ancestors.map((collection) => ({
				id: collection.id,
				label: collection.name,
				onSelect: () => openTab({ type: "collection", entityId: collection.id }),
			})),
			// The blank case is filtered by `TabBreadcrumb`, which is also what
			// makes a request with no collection and no name draw no band at all.
			{ id: "request", label: name },
		],
		[ancestors, name, openTab]
	);
}
