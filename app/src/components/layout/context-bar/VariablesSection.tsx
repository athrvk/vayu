/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Variables in scope on a request tab, and the quick editor over them.
 *
 * This was the whole of `ContextBar.tsx` before the bar grew a section
 * registry. What is left here is the *list*: which definitions won, and the
 * badge naming the scope each won from. The row and the commit path moved to
 * `VariableRow` / `useVariableCommit` when the collection tab grew a variables
 * section of its own - the comments describing the defects they fixed moved
 * with the code they explain.
 */

import { useVariableResolver } from "@/hooks/useVariableResolver";
import { useRequestQuery } from "@/queries";
import { VariableScopeBadge } from "@/components/ui";
import { SectionEmpty } from "./Section";
import { VariableRow } from "./VariableRow";
import { useVariableCommit } from "./variable-commit";
import type { ContextBarSectionProps } from "./types";

export function VariablesSection({ tab }: ContextBarSectionProps) {
	// Resolve the active request's collection so collection-scope variables show up
	const { data: request } = useRequestQuery(tab.entityId);
	const { getAllVariables } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});
	const variables = getAllVariables();
	const commitValue = useVariableCommit();

	const entries = Object.entries(variables);

	if (entries.length === 0) return <SectionEmpty>No variables in scope</SectionEmpty>;

	return (
		<div className="space-y-1">
			{entries.map(([name, resolved]) => (
				<VariableRow
					key={name}
					name={name}
					resolved={resolved}
					marker={<VariableScopeBadge scope={resolved.scope} className="shrink-0" />}
					onCommit={(input) => commitValue(name, resolved, input)}
				/>
			))}
		</div>
	);
}
