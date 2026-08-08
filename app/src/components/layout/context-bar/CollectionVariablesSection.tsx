/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What this collection itself defines, editable in place.
 *
 * Not the same list as the request tab's: that one shows what *resolved* for a
 * request, across all three scopes and with ancestors overriding each other.
 * This one shows the definitions that live on this collection - the rows the
 * Variables tab beside it edits - because on a collection tab the question is
 * "what does this collection contribute", not "what would win".
 *
 * A definition here is already the winner for its own scope, so the commit path
 * is handed a `ResolvedVariable` naming this collection as the source and lands
 * in the same place `useVariableCommit` sends a collection-scope edit from the
 * request tab.
 */

import { useCollectionsQuery } from "@/queries";
import { SectionEmpty, SectionLoading } from "./Section";
import { VariableRow } from "./VariableRow";
import { useVariableCommit } from "./variable-commit";
import type { ContextBarSectionProps } from "./types";
import type { ResolvedVariable } from "@/types";

export function CollectionVariablesSection({ tab }: ContextBarSectionProps) {
	const { data: collections = [], isLoading } = useCollectionsQuery();
	const commitValue = useVariableCommit();

	const collection = collections.find((c) => c.id === tab.entityId);

	if (isLoading && !collection) return <SectionLoading />;
	if (!collection) return <SectionEmpty>This collection is no longer available</SectionEmpty>;

	// Stored order, which is the order the Variables tab shows: its save payload
	// is written oldest-`createdAt` first precisely so the round trip preserves
	// it (`VariableTableEditor`). Re-sorting here would be a second copy of that
	// rule, free to drift from it.
	const entries = Object.entries(collection.variables ?? {});

	if (entries.length === 0) {
		return <SectionEmpty>This collection defines no variables</SectionEmpty>;
	}

	return (
		<div className="space-y-1">
			{entries.map(([name, definition]) => {
				const resolved: ResolvedVariable = {
					value: definition.value,
					scope: "collection",
					sourceId: collection.id,
					sourceName: collection.name,
					secret: definition.secret,
					type: definition.type,
				};
				return (
					<VariableRow
						key={name}
						name={name}
						resolved={resolved}
						// A disabled definition still exists here - it is simply not
						// sent - so hiding it would answer the section's question
						// wrongly. Said in text rather than by colour alone, and not
						// in a `title`, which a keyboard user never sees.
						marker={
							definition.enabled ? undefined : (
								<span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
									off
								</span>
							)
						}
						onCommit={(input) => commitValue(name, resolved, input)}
					/>
				);
			})}
		</div>
	);
}
