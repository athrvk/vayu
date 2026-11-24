/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the open request lives, as crumbs for `TabBreadcrumb` (#1691). Only the chain is
 * builder-specific (collection ancestors, then the request's name); `TabBreadcrumb` draws it, so
 * this module knows a request sits under a collection and the crumb row is defined once for the
 * app. The chain is `useCollectionAncestors` (cycle guard, collections query), so a rename or
 * drag-move updates it from the cache without a refetch. A collection crumb opens its tab; the
 * request's own is inert (you are there), and renaming is the Info tab's, the builder's one rename
 * surface.
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
			// `TabBreadcrumb` filters the blank case, so a request with no collection and no name
			// draws no band.
			{ id: "request", label: name },
		],
		[ancestors, name, openTab]
	);
}
