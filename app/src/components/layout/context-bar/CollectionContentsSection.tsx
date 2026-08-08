/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How much is in this collection, one level down.
 *
 * Direct children only, deliberately: the tree beside the bar draws the same
 * two numbers as the rows under a folder, and a subtree total would disagree
 * with what the user can see there. The pane's own header counts requests but
 * says nothing about nested folders, which is the half this adds.
 */

import { useCollectionsQuery, useRequestsQuery } from "@/queries";
import { SectionEmpty, SectionLoading } from "./Section";
import type { ContextBarSectionProps } from "./types";

/** "1 request" / "3 requests" - the pane header's wording, not a second one. */
function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function CollectionContentsSection({ tab }: ContextBarSectionProps) {
	const { data: collections = [], isLoading: collectionsLoading } = useCollectionsQuery();
	const { data: requests = [], isLoading: requestsLoading } = useRequestsQuery(tab.entityId);

	const collection = collections.find((c) => c.id === tab.entityId);

	if ((collectionsLoading || requestsLoading) && !collection) return <SectionLoading />;
	if (!collection) return <SectionEmpty>This collection is no longer available</SectionEmpty>;

	const children = collections.filter((c) => c.parentId === collection.id);

	return (
		<p className="text-xs text-foreground m-0">
			{count(requests.length, "request")}
			<span className="text-muted-foreground"> · </span>
			{count(children.length, "sub-collection")}
		</p>
	);
}
