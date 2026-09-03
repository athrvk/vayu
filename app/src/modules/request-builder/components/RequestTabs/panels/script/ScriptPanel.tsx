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
 *
 * **The editor fills the panel** (#1223). It was pinned at 350px inside a
 * `flex-1 overflow-y-auto` tab, so on a tall window the one place a user writes
 * code stayed the same height and a wall of reference prose below it took the
 * rest. The prose is gone: what it listed is in the engine's completion table,
 * which `ScriptSnippets` lists insertably and the editor already offers as you
 * type. What is left below the editor is the one fact per variant that a
 * snippet cannot show, beside the link to the docs that carry the rest.
 */

import { useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { Button, Badge, CodeEditor, VariableScopeBadge } from "@/components/ui";
import { ScriptSnippets } from "@/components/shared";
import { insertSnippetAtCursor } from "@/lib/editor-snippet";
import { useRequestBuilderContext } from "../../../../context";
import InheritedScriptsNotice from "../InheritedScriptsNotice";
import LegacyScriptNotice from "../LegacyScriptNotice";
import { SCRIPT_VARIANTS, type ScriptVariant } from "./script-variants";
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

/** How many referenced names get a chip before the rest become a count. */
const CHIP_LIMIT = 5;

export interface ScriptPanelProps {
	variant: ScriptVariant;
}

export default function ScriptPanel({ variant }: ScriptPanelProps) {
	const config = SCRIPT_VARIANTS[variant];
	const context = useRequestBuilderContext();
	const { request, updateField, getAllVariables, getVariableOrigins } = context;
	const [showVariables, setShowVariables] = useState(false);
	const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

	const script = request[config.field];
	const usedVars = referencedVariables(script);
	const allVariables = getAllVariables();
	const hasReferencedVars = usedVars.length > 0;

	return (
		/*
		 * A column that fills the tab panel, for `BodyPanel`'s reason: the editor
		 * was a fixed 350px box inside a pane with the window's height. Everything
		 * but the editor keeps its intrinsic height; `min-h-0` is what lets the
		 * editor shrink below its content when the window is short - including
		 * when the snippets list below it opens (#1223).
		 */
		<div className="flex min-h-0 flex-1 flex-col gap-4">
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
			 *
			 * **"Names mentioned", not "Referenced" (issue #659 item 3).** The row
			 * chipped every name a script writes and painted each one green or red
			 * by whether a variable of that name is in scope - which is a true
			 * answer for a `pm.*.get()` and a false one for a `{{name}}`, because
			 * the engine never interpolates script text (decision D16). A green
			 * `{{base_url}}` chip told the author the send would substitute it. It
			 * will not: those characters reach QuickJS verbatim. #635 fixed the
			 * `data.*` half of this; the rest of the row had the same defect.
			 */}
			{hasReferencedVars && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-xs text-muted-foreground">Names mentioned:</span>
					{usedVars.slice(0, CHIP_LIMIT).map((reference) => {
						const { name, via } = reference;
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
						if (isDataVariableName(name)) {
							const data = describeDataToken(name, context.dataColumns);
							return (
								<Badge
									key={name}
									variant="chip"
									className={cn(
										"font-mono text-xs bg-muted",
										DATA_TOKEN_TONE_CLASS[data.tone]
									)}
									/*
									 * The interpolation note belongs to the spelling
									 * that is literal characters. A `data.*` name
									 * read through `pm.*.get()` is a real call, so
									 * telling its author the text reaches the script
									 * verbatim describes something else entirely.
									 */
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
						/*
						 * A bare name a bound row answers (issue #1063). The same
						 * two states as the `data.*` chip above and painted from
						 * the same table, because `pm.iterationData.get("email")`
						 * and `{{data.email}}` name one column and read one row -
						 * a reader who has to learn two paints for that has been
						 * told the spelling matters, and it does not.
						 *
						 * `pm.variables.get("email")` joins them only while the
						 * name is a declared column no scope defines, which is
						 * exactly the line `VariableInput` already draws for a
						 * bare `{{email}}` in the URL bar. The decision itself is
						 * `describeColumnReference`'s, so the two surfaces cannot
						 * come to disagree about it.
						 */
						const column = describeColumnReference(
							reference,
							context.dataColumns,
							(candidate) => Boolean(allVariables[candidate])
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
						/*
						 * A `{{name}}` the script merely contains. Neutral, and
						 * never the resolved/unresolved pair: whether something in
						 * scope answers to this name has no bearing on a string
						 * nothing substitutes, so both colours would be a lie in
						 * opposite directions. The tooltip carries the rule and
						 * the way to actually read the variable.
						 */
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
						/*
						 * A single-scope read whose own scope answers emptily while
						 * another scope holds the value (issue #1196). Below the
						 * resolved/unresolved pair because `allVariables` answers
						 * about the *winner*: a name the environment defines is in
						 * that map, so `pm.collectionVariables.get("shop_domain")`
						 * got the healthy chip while returning `''`. Amber, because
						 * the read works and the name resolves - it just does not
						 * resolve here.
						 */
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
						/*
						 * A `pm.*.get()` - the script really reads this one, so
						 * "defined" and "not defined" are both meaningful, and the
						 * destructive paint keeps the meaning it always had here.
						 */
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

			<div className="min-h-40 flex-1 rounded-md border border-rule surface-card bg-card overflow-hidden">
				<CodeEditor
					language="javascript"
					ariaLabel={config.editorLabel}
					value={script}
					onChange={(value) => updateField(config.field, value ?? "")}
					onMount={(instance) => {
						editorRef.current = instance;
					}}
				/>
			</div>

			<ScriptSnippets
				context={variant === "pre" ? "pre" : "test"}
				onInsert={(snippet) => insertSnippetAtCursor(editorRef.current, snippet)}
			/>

			{/*
			 * The one fact a snippet cannot show, and the link to the rest. The
			 * guide is every matcher, every `pm.*` member and the rules the
			 * completion table states per member; it opens through the keyed
			 * `openAppLink` channel, which is the only way the renderer can reach
			 * the system browser (a plain anchor would spawn an unmanaged
			 * Electron window).
			 */}
			<div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
				<p>{config.contextNote}</p>
				<button
					type="button"
					className="shrink-0 text-primary-text underline underline-offset-2 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
					onClick={() => window.electronAPI?.openAppLink("scripting")}
				>
					Scripting docs
				</button>
			</div>
		</div>
	);
}
