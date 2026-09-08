/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Names mentioned:" - which variables a `script.pre`/`script.post` element's
 * script references, and how each resolves (issue #1553).
 *
 * Ported from the pre-#1512 `ScriptPanel`/`ScriptTab`, which each read
 * `referencedVariables` and painted `describeDataToken`/`describeColumnReference`/
 * `describeScopedRead` against `DATA_TOKEN_TONE_CLASS` inline, once per host.
 * `ScriptElementForm`, the bespoke form both hosts now use for a script element,
 * is a primitive under `components/shared/` and cannot depend on either host's
 * own context (`useRequestBuilderContext`, or the collection's
 * `useVariableResolver`/`useDataContract` pair) - so this component takes the
 * resolved answers as props instead, and each host supplies its own context's
 * answers through `ElementList`'s `renderAboveForm`. One implementation, not
 * two copies of the same tone table that can drift apart (the two retired
 * panels already had: the collection tab never painted a plain `pm.*` read
 * destructive when nothing defined it, the request panel always did).
 */

import { Badge } from "@/components/ui";
import {
	describeColumnReference,
	describeScopedRead,
	referencedVariables,
	TEMPLATE_IN_SCRIPT_NOTE,
} from "@/lib/referenced-variables";
import { describeDataToken } from "@/lib/data-contract";
import { DATA_TOKEN_TONE_CLASS } from "@/lib/data-token-tone";
import { isDataVariableName } from "@/lib/variable-resolution";
import { cn } from "@/lib/utils";
import type { DataContractScope, ResolvedVariable, VariableOrigin } from "@/types";

export interface ScriptReferencesRowProps {
	script: string;
	allVariables: Record<string, ResolvedVariable>;
	getVariableOrigins: (name: string) => VariableOrigin[];
	dataColumns?: DataContractScope;
	/** How many names get a chip before the rest become a "+N more" count. */
	chipLimit?: number;
}

export function ScriptReferencesRow({
	script,
	allVariables,
	getVariableOrigins,
	dataColumns,
	chipLimit = 5,
}: ScriptReferencesRowProps) {
	const usedVars = referencedVariables(script);
	if (usedVars.length === 0) return null;

	return (
		<div className="flex flex-wrap items-center gap-2">
			<span className="text-xs text-muted-foreground">Names mentioned:</span>
			{usedVars.slice(0, chipLimit).map((reference) => {
				const { name, via } = reference;

				// A `data.*` name is not a variable and never becomes one (#604):
				// the namespace is disjoint from the scopes, so it reads the
				// contract in scope rather than the resolved/unresolved pair, and a
				// column this chip calls declared is the one the URL bar calls
				// declared.
				if (isDataVariableName(name)) {
					const data = describeDataToken(name, dataColumns);
					return (
						<Badge
							key={name}
							variant="chip"
							className={cn(
								"font-mono text-xs bg-muted",
								DATA_TOKEN_TONE_CLASS[data.tone]
							)}
							title={
								via === "template"
									? `${data.description} - ${data.note} ${TEMPLATE_IN_SCRIPT_NOTE}`
									: `${data.description} - ${data.note}`
							}
						>
							{name}
						</Badge>
					);
				}

				// A bare name a bound row answers (#1063): the same two states as
				// the `data.*` chip above, from the same table, since a bound row's
				// column and a `{{data.*}}` name the same thing.
				const column = describeColumnReference(reference, dataColumns, (candidate) =>
					Boolean(allVariables[candidate])
				);
				if (column) {
					return (
						<Badge
							key={name}
							variant="chip"
							className={cn(
								"font-mono text-xs bg-muted",
								DATA_TOKEN_TONE_CLASS[column.tone]
							)}
							title={`${column.description} - ${column.note}`}
						>
							{name}
						</Badge>
					);
				}

				// A `{{name}}` the script merely contains - never resolved/unresolved,
				// since the engine never interpolates script text (decision D16).
				if (via === "template") {
					return (
						<Badge
							key={name}
							variant="chip"
							className="font-mono text-xs bg-muted text-muted-foreground"
							title={TEMPLATE_IN_SCRIPT_NOTE}
						>
							{`{{${name}}}`}
						</Badge>
					);
				}

				// A single-scope read whose own scope answers emptily while another
				// scope holds the value (#1196) - amber, since the read works and the
				// name resolves, just not here.
				const scoped = describeScopedRead(reference, getVariableOrigins(name));
				if (scoped) {
					return (
						<Badge
							key={name}
							variant="chip"
							className={cn(
								"font-mono text-xs bg-muted",
								DATA_TOKEN_TONE_CLASS[scoped.tone]
							)}
							title={`${scoped.description} - ${scoped.note}`}
						>
							{name}
						</Badge>
					);
				}

				// A `pm.*.get()` the script really reads: "defined"/"not defined" are
				// both meaningful here, so the destructive paint keeps its meaning.
				return (
					<Badge
						key={name}
						variant={allVariables[name] ? "secondary" : "destructive"}
						className="font-mono text-xs"
						title={
							allVariables[name]
								? `${name} resolves in the current scope.`
								: `Nothing in scope defines ${name}; pm.environment.get("${name}") returns undefined.`
						}
					>
						{name}
					</Badge>
				);
			})}
			{usedVars.length > chipLimit && (
				<span className="text-xs text-muted-foreground">
					+{usedVars.length - chipLimit} more
				</span>
			)}
		</div>
	);
}
