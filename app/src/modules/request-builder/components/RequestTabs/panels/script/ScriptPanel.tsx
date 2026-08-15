/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The script editor, for both ends of a request.
 *
 * `PreScriptPanel` and `TestScriptPanel` were two files of ~155 lines that a
 * normalised `diff` showed differing in three places. Everything that differs
 * is now data in `script-variants.tsx`; this is the panel both render.
 *
 * **The full variable list is a sunken slab, not `bg-muted/50` with a border
 * token.** `--muted` is the one surface where no border token works - it sits
 * *between* `--border` and `--border-strong` in dark, so `border-input` there
 * was either invisible or wrong depending on the theme. `surface-sunken`
 * declares a `--rule` that reads on it, and `border-rule` inherits that.
 */

import { useState } from "react";
import { Button, Badge, CodeEditor, VariableScopeBadge } from "@/components/ui";
import { useRequestBuilderContext } from "../../../../context";
import InheritedScriptsNotice from "../InheritedScriptsNotice";
import LegacyScriptNotice from "../LegacyScriptNotice";
import { SCRIPT_VARIANTS, type ScriptVariant } from "./script-variants";
import { referencedVariables } from "@/lib/referenced-variables";
import { describeDataToken } from "@/lib/data-contract";
import { DATA_TOKEN_TONE_CLASS } from "@/lib/data-token-tone";
import { isDataVariableName } from "@/lib/variable-resolution";
import { cn } from "@/lib/utils";

/** How many referenced names get a chip before the rest become a count. */
const CHIP_LIMIT = 5;

export interface ScriptPanelProps {
	variant: ScriptVariant;
}

export default function ScriptPanel({ variant }: ScriptPanelProps) {
	const config = SCRIPT_VARIANTS[variant];
	const context = useRequestBuilderContext();
	const { request, updateField, getAllVariables } = context;
	const [showVariables, setShowVariables] = useState(false);

	const script = request[config.field];
	const usedVars = referencedVariables(script);
	const allVariables = getAllVariables();
	const hasReferencedVars = usedVars.length > 0;

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">{config.intro}</p>
				{hasReferencedVars && (
					<Button
						size="sm"
						variant={showVariables ? "secondary" : "outline"}
						onClick={() => setShowVariables(!showVariables)}
					>
						{showVariables ? "Hide" : "Show"} all variables
					</Button>
				)}
			</div>

			{/* `entries` wins when the caller supplied them - a copy of a past run
			    lists what that run recorded, not what the collection reads now. */}
			<InheritedScriptsNotice
				variant={variant}
				collectionId={request.collectionId}
				entries={context[config.inheritedKey]}
			/>

			<LegacyScriptNotice variant={variant} script={context[config.legacyKey]} />

			{/*
			 * The referenced list stays put when the full list opens. "Show
			 * Variables" used to replace it, so the button promising more
			 * information removed the more useful half - the names this script
			 * actually mentions, and whether each one resolves - and gave back an
			 * unfiltered dump of everything in scope. The two answer different
			 * questions, so both are shown and the button names the one it opens.
			 */}
			{hasReferencedVars && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-xs text-muted-foreground">Referenced:</span>
					{usedVars.slice(0, CHIP_LIMIT).map((varName) => {
						/*
						 * A `data.*` name is not a variable and never becomes one
						 * (issue #604): the namespace is disjoint from the scopes,
						 * so `allVariables` cannot hold it and the red chip below
						 * was reporting "not defined" about a name for which that
						 * is not a defect - the same paint #592 removed from the
						 * builder, left behind here.
						 *
						 * It reads the contract in scope through `describeDataToken`
						 * rather than inventing a fourth state, so a column this
						 * chip calls declared is the one the token in the URL bar
						 * calls declared. Muted or amber, never destructive.
						 */
						if (isDataVariableName(varName)) {
							const data = describeDataToken(varName, context.dataColumns);
							return (
								<Badge
									key={varName}
									variant="chip"
									className={cn(
										"font-mono text-xs bg-muted",
										DATA_TOKEN_TONE_CLASS[data.tone]
									)}
									title={`${data.description} - ${data.note}`}
								>
									{varName}
								</Badge>
							);
						}
						return (
							<Badge
								key={varName}
								variant={allVariables[varName] ? "secondary" : "destructive"}
								className="font-mono text-xs"
							>
								{varName}
							</Badge>
						);
					})}
					{usedVars.length > CHIP_LIMIT && (
						<span className="text-xs text-muted-foreground">
							+{usedVars.length - CHIP_LIMIT} more
						</span>
					)}
				</div>
			)}

			{/*
			 * `VariableScopeBadge`, not a hand-rolled outline badge printing
			 * `scope[0]`. The primitive is where the scope colours live, and this
			 * panel bypassed it - so global, collection and environment all read as
			 * the same colourless chip, in the one place a script author comes to
			 * tell them apart.
			 */}
			{showVariables && (
				<div className="p-3 surface-sunken rounded-md border border-rule max-h-40 overflow-y-auto">
					<div className="grid grid-cols-2 gap-2 text-xs font-mono">
						{Object.entries(allVariables).map(([name, info]) => (
							<div key={name} className="flex items-center gap-2">
								<VariableScopeBadge scope={info.scope} variant="compact" />
								<span className="text-muted-foreground">{name}:</span>
								<span className="truncate">{info.value}</span>
							</div>
						))}
					</div>
				</div>
			)}

			<div className="rounded-md border border-rule surface-card bg-card overflow-hidden">
				<CodeEditor
					height="350px"
					language="javascript"
					value={script}
					onChange={(value) => updateField(config.field, value ?? "")}
				/>
			</div>

			<div className="text-xs text-muted-foreground space-y-1">
				{/*
				 * The quick reference is six lines; the scripting guide is the rest
				 * of the API - every matcher, every `pm.*` member, and the rules
				 * these notes only summarise. It goes to the published docs site
				 * through the keyed `openAppLink` channel, which is the only way
				 * the renderer can reach the system browser (a plain anchor would
				 * spawn an unmanaged Electron window).
				 */}
				<div className="flex items-center justify-between gap-2">
					<p className="font-medium">Quick Reference:</p>
					<button
						type="button"
						className="text-primary-text underline underline-offset-2 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
						onClick={() => window.electronAPI?.openAppLink("scripting")}
					>
						Scripting docs
					</button>
				</div>
				<pre className="m-0 p-2 surface-sunken rounded-md border border-rule font-mono whitespace-pre-wrap">
					{config.quickReference.join("\n")}
				</pre>
				{/*
				 * The rules a snippet cannot show. `list-disc` needs the inside
				 * position: the panel has no gutter to hang markers in, and
				 * outside markers would sit under the pre block's left edge.
				 */}
				<ul className="list-disc list-inside space-y-1 pt-1">
					{config.notes.map((note, index) => (
						<li key={index}>{note}</li>
					))}
				</ul>
			</div>
		</div>
	);
}
