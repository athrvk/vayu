/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What this collection hands down to the requests under it.
 *
 * The request tab's twin of this section answers "what am I sending"; here the
 * subject is the other end of the same walk - a collection is always a source,
 * never an inheritor (`Collection.auth` excludes `inherit`), so what matters is
 * what a descendant set to Inherit would pick up.
 *
 * A collection that configures nothing is not the end of the answer: the walk
 * carries on to *its* ancestors, and one of them set to No Auth stops it. That
 * is `resolveAuthSource` - the same function the Auth tab's inheritance chain
 * and both send paths use, so this cannot claim a source execution would not.
 */

import { useCollectionsQuery, useCollectionAncestors } from "@/queries";
import { AUTH_MODE_LABELS } from "@/constants/auth-modes";
import { resolveAuthSource } from "@/modules/request-builder/utils/auth-resolution";
import { SectionEmpty, SectionLoading } from "./Section";
import type { ContextBarSectionProps } from "./types";

export function CollectionAuthSection({ tab }: ContextBarSectionProps) {
	const { data: collections = [], isLoading } = useCollectionsQuery();
	const ancestors = useCollectionAncestors(tab.entityId);

	const collection = collections.find((c) => c.id === tab.entityId);

	// `resolveAuthSource` is called unconditionally on the chain, which includes
	// this collection: when it configures auth it is its own answer, and when it
	// is set to plain `none` the walk steps over it to the nearest ancestor that
	// does - the same result a descendant's Inherit would land on.
	const { source, blockedBy } = resolveAuthSource(ancestors);

	if (isLoading && !collection) return <SectionLoading />;
	if (!collection) return <SectionEmpty>This collection is no longer available</SectionEmpty>;

	const own = collection.auth.mode;
	const label = AUTH_MODE_LABELS[own];

	const origin =
		own === "noauth"
			? "Requests below inherit nothing - the walk stops here."
			: own !== "none"
				? "Requests set to Inherit send this."
				: source
					? `Requests below inherit ${AUTH_MODE_LABELS[source.auth.mode]} from ${source.name}.`
					: blockedBy
						? `${blockedBy.name} is set to No Auth, so nothing is inherited past it.`
						: "No ancestor collection defines auth either.";

	return (
		<div className="space-y-2">
			<p className="text-xs text-foreground m-0">
				Set to <span className="font-semibold text-primary">{label}</span>
			</p>
			<p className="text-[11px] text-muted-foreground m-0">{origin}</p>
		</div>
	);
}
