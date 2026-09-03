/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The variables the open request uses, and the quick editor over them.
 *
 * The list used to be the whole resolver - every global, environment and
 * collection definition in the workspace - so on a busy workspace it was a scroll
 * of names the request never mentions, and the one question a user has while
 * editing a request ("does `{{shop_domain}}` resolve, is `{{vault_path}}` defined
 * at all") was buried or, for an undefined reference, absent (#1308). It now leads
 * with what *this request references*, resolved or not, and keeps the full list a
 * disclosure away so the quick-edit-anything path is not lost.
 *
 * The bar sits outside `RequestBuilderProvider` and reads the stored request via
 * `useRequestQuery`, so the reference set lags the live editor buffer by the
 * autosave interval - the same lag the GraphQL section's outline documents. That
 * is deliberate: reading the editor buffer from the bar would duplicate provider
 * state here.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	VariableScopeBadge,
} from "@/components/ui";
import { TruncatedText } from "@/components/shared";
import { SectionEmpty, SectionLoading } from "./Section";
import { VariableRow } from "./VariableRow";
import { useRequestVariables } from "./relevance";
import { useVariableCommit } from "./variable-commit";
import type { ContextBarSectionProps } from "./types";

export function VariablesSection({ tab }: ContextBarSectionProps) {
	const derived = useRequestVariables(tab);
	const commitValue = useVariableCommit();
	const [showAll, setShowAll] = useState(false);

	if (!derived) return <SectionLoading />;

	const { references, resolvedRefs, undefinedRefs, rest } = derived;

	// Nothing referenced *and* nothing in scope: there is genuinely nothing to
	// say, distinct from "this request uses none but others are in scope" below.
	// The bar reduces this section to a dimmed header before it gets here
	// (`useVariablesRelevance`), so this is the honest answer for a caller that
	// mounts the section directly, and the answer during the render in which the
	// last definition in scope goes away.
	if (references.length === 0 && rest.length === 0) {
		return <SectionEmpty>No variables in scope</SectionEmpty>;
	}

	return (
		<div className="space-y-1">
			{resolvedRefs.map(({ name, resolved }) => (
				<VariableRow
					key={name}
					name={name}
					resolved={resolved}
					marker={<VariableScopeBadge scope={resolved.scope} className="shrink-0" />}
					onCommit={(input) => commitValue(name, resolved, input)}
				/>
			))}

			{undefinedRefs.map((name) => (
				// Referenced but nothing defines it. No input - there is nothing to
				// commit to - and the destructive tone the editor and popover already
				// use for an unresolved token, so one vocabulary says "undefined".
				<div key={name} className="grid grid-cols-2 gap-2 items-center">
					<div className="flex items-center gap-1.5 min-w-0 px-1">
						<TruncatedText className="text-xs font-mono text-destructive-text">
							{name}
						</TruncatedText>
					</div>
					<span className="text-[10px] uppercase tracking-wide text-destructive-text shrink-0">
						not defined
					</span>
				</div>
			))}

			{references.length === 0 && <SectionEmpty>This request uses no variables</SectionEmpty>}

			{rest.length > 0 && (
				<Collapsible open={showAll} onOpenChange={setShowAll} className="pt-1">
					<CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
						{showAll ? (
							<ChevronDown className="w-3 h-3 shrink-0" />
						) : (
							<ChevronRight className="w-3 h-3 shrink-0" />
						)}
						All in scope ({rest.length})
					</CollapsibleTrigger>
					<CollapsibleContent className="mt-1 space-y-1">
						{showAll &&
							rest.map(([name, resolved]) => (
								<VariableRow
									key={name}
									name={name}
									resolved={resolved}
									marker={
										<VariableScopeBadge
											scope={resolved.scope}
											className="shrink-0"
										/>
									}
									onCommit={(input) => commitValue(name, resolved, input)}
								/>
							))}
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}
