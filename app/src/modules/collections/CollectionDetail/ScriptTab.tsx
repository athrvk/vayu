/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ScriptTab
 *
 * Monaco-backed editor for a collection's pre- or post-request script.
 *
 * Composition order is the same for both kinds: outer → inner → request. The
 * collection chain runs root-first, then the request's own script last
 * (`scriptParts` in request-builder/utils, and its MCP twin in resolve.ts;
 * the engine joins the parts and runs them as one script).
 *
 * This used to claim post ran request-first and unwound outward. It never did -
 * both paths have always built the chain root-first and appended the request's
 * own. The banner below said so to users, which is worse than saying it here.
 *
 * Used by both the Pre-request and Post-request tabs in CollectionDetail.
 *
 * **It used to demand an explicit Save.** A script is a text buffer, and the two
 * other places you edit one - the request builder's script panels and this
 * screen's own description field - both persist it without being asked. Both
 * kinds now commit when focus leaves the editor, like `InfoTab`. The Auth tab
 * deliberately did *not* follow: its form is up to 20 focus stops, 9 of which
 * are not value fields, so a blur there is not a completion signal (see #446 and
 * `useEntityDraft`). This editor has exactly one.
 */

import { useCallback, useMemo, useRef } from "react";
import type * as Monaco from "monaco-editor";
import { Badge, Button, CodeEditor } from "@/components/ui";
import { ScriptSnippets } from "@/components/shared";
import { insertSnippetAtCursor } from "@/lib/editor-snippet";
import { useDraftSaveContext, useEntityDraft } from "@/hooks";
import { useUpdateCollectionMutation } from "@/queries/collections";
import {
	describeColumnReference,
	describeScopedRead,
	referencedVariables,
	TEMPLATE_IN_SCRIPT_NOTE,
} from "@/lib/referenced-variables";
import { describeDataToken } from "@/lib/data-contract";
import { DATA_TOKEN_TONE_CLASS } from "@/lib/data-token-tone";
import { isDataVariableName } from "@/lib/variable-resolution";
import { useDataContract, useVariableResolver } from "@/hooks";
import { cn } from "@/lib/utils";
import type { Collection } from "@/types";
import { InfoBanner, SaveFailed } from "./shared";

type ScriptKind = "pre" | "post";

interface ScriptTabProps {
	collection: Collection;
	kind: ScriptKind;
	/** Whether this is the tab on screen - see `useDraftSaveContext`. */
	active?: boolean;
}

export default function ScriptTab({ collection, kind, active = false }: ScriptTabProps) {
	const isPre = kind === "pre";
	const fieldKey = isPre ? "preRequestScript" : "postRequestScript";

	const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
	const updateCollection = useUpdateCollectionMutation();

	// Draft/resync/isDirty/mutation-reset all live in the shared hook - the
	// three collection tabs used to hand-roll it one each. See useEntityDraft.
	//
	// The kind is part of the entity key: pre and post are two different things
	// to edit, even though only one of them is mounted at a time (the tab shell
	// renders just the active panel).
	const {
		draft: script,
		setDraft: setScript,
		isDirty,
	} = useEntityDraft<string>({
		entityKey: `${collection.id}:${fieldKey}`,
		value: collection[fieldKey] ?? "",
		mutation: updateCollection,
	});

	// Both kinds go through the shared extraction. This tab used to re-implement
	// it - the same two regexes, the same dedupe - so the empty-name filter that
	// landed in the helper never reached the pre- and post-request tabs here.
	const usedVars = useMemo(() => referencedVariables(script), [script]);

	/*
	 * The same two answers the request panel paints its chips from (issue #1075).
	 * This tab had neither, so a column read here was a flat accent chip while
	 * the identical script in a request said which contract declares the column
	 * and whether it does - one script, two readings, decided by which screen it
	 * was pasted into. The contract is the one in scope for *this* collection's
	 * chain, which is the chain the engine hands a script running under it.
	 */
	const dataColumns = useDataContract(collection.id);
	const { getAllVariables, getVariableOrigins } = useVariableResolver({
		collectionId: collection.id,
	});
	// Once per render, not once per chip: `getAllVariables` spreads a fresh map
	// on every call, so asking it inside the row would rebuild the scopes for
	// each name in it.
	const allVariables = getAllVariables();

	// Takes the text rather than reading the draft, so Clear can write the empty
	// script on the same tick it sets it - `setScript` has not landed yet when
	// the handler runs, and a `persist()` there would save the old text.
	const persistText = useCallback(
		async (text: string) => {
			await updateCollection.mutateAsync({ id: collection.id, [fieldKey]: text });
		},
		[updateCollection, collection.id, fieldKey]
	);

	const persist = useCallback(async () => {
		if (!isDirty) return;
		await persistText(script);
	}, [isDirty, persistText, script]);

	useDraftSaveContext({
		id: `collection-${collection.id}-${fieldKey}`,
		name: `Collection ${isPre ? "pre-request" : "post-request"} script: ${collection.name}`,
		isDirty,
		isActive: active,
		save: persist,
	});

	// A rejection here is rendered by <SaveFailed> below; the store-driven paths
	// toast instead, since this callout may not be on screen at all.
	const commit = () => void persist().catch(() => {});

	/*
	 * Commit when focus leaves the editor - the blur Monaco does not expose.
	 *
	 * `focusout` bubbles, so the wrapper hears the internal textarea losing
	 * focus; `relatedTarget` inside the wrapper means focus only moved *within*
	 * the editor (the find widget takes focus on Ctrl+F) and nothing has been
	 * finished. Leaving to nowhere - a click on empty page - reports a null
	 * relatedTarget, which `contains` correctly reads as "outside".
	 *
	 * The alternative was an `onBlur` prop on `CodeEditor` wired to Monaco's
	 * `onDidBlurEditorWidget`. Rejected: every suite that mounts the editor
	 * stubs the instance, so a shared primitive reaching for one more method
	 * makes each stub a place the next method can be forgotten - and the
	 * container's own focusout answers the same question in the DOM, where the
	 * tests already live.
	 */
	const handleEditorFocusOut = (event: React.FocusEvent<HTMLDivElement>) => {
		if (event.currentTarget.contains(event.relatedTarget)) return;
		commit();
	};

	// Clearing is a button press, so it persists on the press - there is no
	// later blur to carry it (focus is on the button, not the editor). Monaco's
	// undo stack still holds the text, and undoing re-commits it on the way out.
	const handleClear = () => {
		setScript("");
		void persistText("").catch(() => {});
	};

	return (
		<div className="max-w-[680px] flex flex-col gap-3.5">
			<InfoBanner>
				This script runs <strong>{isPre ? "before" : "after"} every request</strong> in this
				collection. Scripts compose outer→inner: the parent collection runs first, then
				child folders, then the request&apos;s own script. This enables centralized{" "}
				{isPre
					? "auth refresh and pre-flight setup"
					: "shared test assertions and teardown"}
				.
			</InfoBanner>

			{/*
			 * "Names mentioned", and each chip in the syntax the script actually
			 * used (issue #659 item 3). Every name was printed as `{{name}}` in
			 * the variable accent - including the ones written as
			 * `pm.globals.get("name")`, which are not templates at all - and the
			 * accent on a `{{}}` chip read as "this resolves". Neither is true
			 * here: the engine never interpolates script text (decision D16), so
			 * a `{{}}` in a collection script is literal characters.
			 */}
			{usedVars.length > 0 && (
				<div className="flex flex-wrap gap-1.5 items-center">
					<span className="text-[11px] text-muted-foreground">Names mentioned:</span>
					{usedVars.slice(0, 8).map((reference) => {
						const { name, via } = reference;
						/*
						 * A column, by either spelling, painted from the one table
						 * `DATA_TOKEN_TONE_CLASS` - never the accent, which claims a
						 * variable answers, and never destructive, which #604 removed
						 * from this reading. The decision is `describeColumnReference`'s
						 * so this tab reads the rule rather than owning a copy of it.
						 */
						const data = isDataVariableName(name)
							? describeDataToken(name, dataColumns)
							: describeColumnReference(reference, dataColumns, (candidate) =>
									Boolean(allVariables[candidate])
								);
						if (data) {
							return (
								<Badge
									key={name}
									variant="chip"
									className={cn(
										"font-mono text-[10px] bg-muted border-0",
										DATA_TOKEN_TONE_CLASS[data.tone]
									)}
									title={
										via === "template"
											? `${data.description} - ${data.note} ${TEMPLATE_IN_SCRIPT_NOTE}`
											: `${data.description} - ${data.note}`
									}
								>
									{via === "pm" ? name : `{{${name}}}`}
								</Badge>
							);
						}
						/*
						 * A single-scope read whose own scope answers emptily while
						 * another scope holds the value (issue #1196). The accent
						 * below says "a variable answers this", which is true of the
						 * name and false of this read: an enabled, empty collection
						 * row makes `pm.collectionVariables.get` return `''` while
						 * `{{name}}` resolves the environment's value. Amber, and
						 * `describeScopedRead`'s decision rather than a copy of it,
						 * so this tab and the request panel cannot come to disagree.
						 */
						const scoped = describeScopedRead(reference, getVariableOrigins(name));
						if (scoped) {
							return (
								<Badge
									key={name}
									variant="chip"
									className={cn(
										"font-mono text-[10px] bg-muted border-0",
										DATA_TOKEN_TONE_CLASS[scoped.tone]
									)}
									title={`${scoped.description} - ${scoped.note}`}
								>
									{name}
								</Badge>
							);
						}
						return (
							<Badge
								key={name}
								variant="chip"
								className={
									via === "pm"
										? "font-mono text-[10px] bg-primary/10 text-variable border-0"
										: "font-mono text-[10px] bg-muted text-muted-foreground border-0"
								}
								title={via === "pm" ? undefined : TEMPLATE_IN_SCRIPT_NOTE}
							>
								{via === "pm" ? name : `{{${name}}}`}
							</Badge>
						);
					})}
					{usedVars.length > 8 && (
						<span className="text-[10px] text-muted-foreground">
							+{usedVars.length - 8} more
						</span>
					)}
				</div>
			)}

			<div
				className="border border-border rounded-md overflow-hidden"
				onBlur={handleEditorFocusOut}
			>
				<div className="flex items-center gap-2.5 px-3 py-1.5 bg-panel border-b border-border">
					<span className="text-[11px] font-mono text-muted-foreground">
						{isPre ? "pre-request.js" : "post-request.js"}
					</span>
					<span className="ml-auto text-[10px] text-muted-foreground">JavaScript</span>
				</div>
				<CodeEditor
					height="320px"
					language="javascript"
					ariaLabel={`Collection ${isPre ? "pre-request" : "post-request"} script`}
					value={script}
					onChange={setScript}
					fontSize={12}
					onMount={(instance) => {
						editorRef.current = instance;
					}}
				/>
			</div>

			{/*
			 * The same snippets surface the request script panels use, from the
			 * same engine table (#1223). This tab used to carry its own four-card
			 * grid of copy-me prose: a second implementation of one concept, with
			 * different content, that neither inserted nor remembered whether the
			 * user wanted it open.
			 */}
			<ScriptSnippets
				context={isPre ? "pre" : "test"}
				onInsert={(snippet) => insertSnippetAtCursor(editorRef.current, snippet)}
			/>

			<SaveFailed mutation={updateCollection} what="the script" />

			<div className="flex gap-2">
				<Button
					variant="outline"
					onClick={handleClear}
					disabled={!script || updateCollection.isPending}
				>
					Clear
				</Button>
			</div>
		</div>
	);
}
