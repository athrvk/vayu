/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The templates a script editor offers, insertable at the cursor.
 *
 * **It replaced two walls of prose.** Under every script editor sat a 14-line
 * `<pre>` and nine paragraphs of rules the reader could only retype (the request
 * panel), and a second, differently shaped four-card grid on the collection tab
 * (#1223). Neither could be inserted, and between them they restated a subset of
 * what the editor already knows: the engine's completion table carries every one
 * of those lines as a template with placeholders and documentation, and Monaco
 * shows them as you type. What the table could not say was which script kind a
 * template belongs in, so it could not be *listed*; it says so now (`context`),
 * and this is the one surface that lists it, for both hosts.
 *
 * **`Command`, not a hand-rolled list.** Arrow keys, the highlight, Enter to
 * activate and filtering are all `cmdk`'s, which the palette and the header
 * suggestions already use - a second copy of that keyboard handling is the
 * defect `suggestion-list.tsx` was written to end.
 *
 * **Collapsed by default, and remembered in `layout-store`.** The editor is what
 * the panel is for. A list open under every editor would be the wall it replaced
 * with a chevron on it, and component state would forget the choice on the next
 * tab switch, which unmounts the panel.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	EYEBROW_CLASS,
} from "@/components/ui";
import { useScriptCompletionsQuery } from "@/queries";
import { useLayoutStore } from "@/stores";
import { countSnippets, snippetsForContext } from "@/lib/script-snippets";
import type { SnippetInsertion, SnippetPlacement } from "@/lib/editor-snippet";
import { cn } from "@/lib/utils";

export interface ScriptSnippetsProps {
	/** Which editor this list sits under. */
	context: "pre" | "test";
	/**
	 * Insert the template. The host owns the editor instance, so it owns the
	 * insertion; this list says which template was chosen and narrates what came
	 * back.
	 */
	onInsert: (snippet: string) => SnippetInsertion | null;
}

/**
 * How each landing reads out loud, in the shape the GraphQL explorer's
 * `PLACEMENT_PHRASE` set: "Inserted X <phrase>."
 */
const PLACEMENT_PHRASE: Record<SnippetPlacement, string> = {
	cursor: "at the cursor",
	"end-of-script": "at the end of the script",
};

export function ScriptSnippets({ context, onInsert }: ScriptSnippetsProps) {
	const collapsed = useLayoutStore((s) => s.scriptSnippetsCollapsed);
	const setCollapsed = useLayoutStore((s) => s.setScriptSnippetsCollapsed);
	const { data, isPending, isError } = useScriptCompletionsQuery();

	const groups = snippetsForContext(data?.completions, context);
	const total = countSnippets(groups);

	/*
	 * What just happened, said out loud - the explorer's pattern and its reason
	 * (`GraphQLBody.tsx`): an insertion lands out of sight of the list that
	 * asked for it, and a live region only speaks when its text *changes*, so
	 * the same template twice would be silent the second time and read as the
	 * click not landing. The sequence number is what makes the repeat audible.
	 */
	const [announcement, setAnnouncement] = useState<{ text: string; seq: number }>({
		text: "",
		seq: 0,
	});
	const say = (text: string) => setAnnouncement((prev) => ({ text, seq: prev.seq + 1 }));

	/*
	 * The one outcome with nothing to look at. An insertion shows itself in the
	 * editor; a refusal reaching `sr-only` text alone is a click that, to a
	 * sighted user, did nothing - which is the defect this whole surface was
	 * fixed for. Cleared by the next insertion that lands.
	 */
	const [notice, setNotice] = useState("");

	const insert = (snippet: string, label: string) => {
		const result = onInsert(snippet);
		if (!result) {
			const refusal =
				"That snippet had no editor to go into. Click in the editor and try again.";
			setNotice(refusal);
			say(refusal);
			return;
		}
		setNotice("");
		say(`Inserted ${label} ${PLACEMENT_PHRASE[result.placement]}.`);
	};

	return (
		<Collapsible open={!collapsed} onOpenChange={(open) => setCollapsed(!open)}>
			{/*
			 * The whole header is the control, per the composite-row hit-area rule:
			 * a narrow activator in a wide bar leaves most of the row painting a
			 * hover it does not act on.
			 */}
			<CollapsibleTrigger
				className={cn(
					EYEBROW_CLASS,
					"flex w-full items-center gap-1 text-left transition-colors hover:text-foreground"
				)}
			>
				{collapsed ? (
					<ChevronRight className="w-3 h-3 shrink-0" />
				) : (
					<ChevronDown className="w-3 h-3 shrink-0" />
				)}
				Snippets
				{total > 0 && <span className="ml-1 tabular-nums opacity-70">{total}</span>}
			</CollapsibleTrigger>

			{notice && (
				<p className="mt-2 text-xs text-muted-foreground" role="status">
					{notice}
				</p>
			)}
			<span key={announcement.seq} className="sr-only" aria-live="polite">
				{announcement.text}
			</span>

			<CollapsibleContent className="mt-2">
				{!collapsed && (
					/*
					 * A card, not a sunken slab, because `Command` declares
					 * `bg-card surface-card` itself: a `bg-transparent` override
					 * would replace the background utility and leave the surface
					 * class standing, so the filter field's own `border-rule`
					 * would resolve to the card's value inside a sunken box. One
					 * surface for the box and its contents is the only spelling
					 * where every rule inside it reads on what it sits on.
					 */
					<div className="rounded-md border border-rule surface-card bg-card overflow-hidden">
						{isError ? (
							<p className="px-3 py-2 text-xs text-muted-foreground">
								Snippets come from the engine, which is not answering right now.
							</p>
						) : isPending ? (
							<p className="px-3 py-2 text-xs text-muted-foreground">
								Loading snippets…
							</p>
						) : (
							<Command>
								<CommandInput placeholder="Filter snippets" />
								<CommandList className="max-h-56">
									<CommandEmpty>No snippet matches that.</CommandEmpty>
									{groups.map(({ group, snippets }) => (
										<CommandGroup key={group} heading={group}>
											{snippets.map((snippet) => (
												<CommandItem
													key={snippet.label}
													value={`${group} ${snippet.label} ${snippet.filterText ?? ""}`}
													onSelect={() =>
														insert(snippet.insertText, snippet.label)
													}
													className="cursor-pointer flex-col items-start gap-0.5"
												>
													<span className="font-mono text-xs">
														{snippet.label}
													</span>
													{snippet.detail && (
														<span className="text-[11px] text-muted-foreground">
															{snippet.detail}
														</span>
													)}
												</CommandItem>
											))}
										</CommandGroup>
									))}
								</CommandList>
							</Command>
						)}
					</div>
				)}
			</CollapsibleContent>
		</Collapsible>
	);
}
