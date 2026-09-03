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
import { useVariableResolver } from "@/hooks/useVariableResolver";
import { useRequestQuery, useCollectionAncestors } from "@/queries";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	VariableScopeBadge,
} from "@/components/ui";
import { TruncatedText } from "@/components/shared";
import { resolveEffectiveAuth } from "@/modules/request-builder/utils/auth-resolution";
import { referencedVariableNames } from "@/lib/request-references";
import { SectionEmpty, SectionLoading } from "./Section";
import { VariableRow } from "./VariableRow";
import { useVariableCommit } from "./variable-commit";
import type { ContextBarSectionProps } from "./types";
import type { ResolvedVariable } from "@/types";

export function VariablesSection({ tab }: ContextBarSectionProps) {
	const { data: request } = useRequestQuery(tab.entityId);
	const ancestors = useCollectionAncestors(request?.collectionId ?? null);
	const { getVariable, getAllVariables } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});
	const commitValue = useVariableCommit();
	const [showAll, setShowAll] = useState(false);

	if (!request) return <SectionLoading />;

	// The auth the request *sends* - `inherit` walked - so a `{{token}}` in an
	// inherited credential counts as a reference.
	const references = referencedVariableNames({
		url: request.url ?? "",
		params: request.params ?? [],
		headers: request.headers ?? [],
		body: request.body ?? { mode: "none" },
		preRequestScript: request.preRequestScript ?? "",
		postRequestScript: request.postRequestScript ?? "",
		resolvedAuth: resolveEffectiveAuth(request.auth ?? { mode: "none" }, ancestors),
	});

	const classified = references.map((name) => ({ name, resolved: getVariable(name) }));
	const resolvedRefs = classified.filter(
		(r): r is { name: string; resolved: ResolvedVariable } => r.resolved !== null
	);
	const undefinedRefs = classified.filter((r) => r.resolved === null).map((r) => r.name);

	// The disclosure is "everything else in scope": the full resolved set minus the
	// referenced names already shown above it, so a name is never listed twice.
	const shownAtTop = new Set(resolvedRefs.map((r) => r.name));
	const rest = Object.entries(getAllVariables()).filter(([name]) => !shownAtTop.has(name));

	// Nothing referenced *and* nothing in scope: there is genuinely nothing to
	// say, distinct from "this request uses none but others are in scope" below.
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
