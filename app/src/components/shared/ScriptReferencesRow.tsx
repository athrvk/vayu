/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Names mentioned:": which variables a `script.pre`/`script.post` element's script references, and
 * how each resolves (#1553). `ScriptElementForm`, the script form both hosts use, is a
 * `components/shared/` primitive and cannot reach either host's context
 * (`useRequestBuilderContext`, or the collection's `useVariableResolver`/`useDataContract`), so
 * this takes the resolved answers as props, each host supplying its own through `ElementList`'s
 * `renderAboveForm`. One tone table, not two that drift (the pre-#1512 panels' copies disagreed on
 * painting an undefined `pm.*` read).
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

				// A `data.*` name is never a variable (#604): its namespace is disjoint from the
				// scopes, so it reads the contract in scope, not resolved/unresolved, and a column
				// this chip calls declared is the one the URL bar does.
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

				// A bare name a bound row answers (#1063): the `data.*` chip's two states from the
				// same table, as a row's column and `{{data.*}}` name the same thing.
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

				// A `{{name}}` the script merely contains: never resolved/unresolved, as the engine
				// never interpolates script text (decision D16).
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

				// A single-scope read whose own scope answers emptily while another holds the value
				// (#1196): amber, as the read works and the name resolves, just not here.
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

				// A real `pm.*.get()` read: "defined"/"not defined" both mean something, so the
				// destructive paint keeps its meaning.
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
