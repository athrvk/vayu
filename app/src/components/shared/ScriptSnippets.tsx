/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The templates a script editor offers, insertable at the cursor, the one surface listing them for
 * both hosts (#1223). The engine's completion table carries every template with placeholders and
 * docs, and Monaco shows them as you type; its `context` says which script kind each belongs in,
 * which is what makes them listable.
 *
 * **`Command`, not a hand-rolled list**: arrows, highlight, Enter and filtering are `cmdk`'s, as in
 * the palette and header suggestions; a second copy of that keyboard handling is what
 * `suggestion-list.tsx` ended.
 *
 * **Collapsed by default, remembered by the host**: the editor is what the panel is for, and an
 * open list under every editor would be a wall of prose with a chevron. The flag is a controlled
 * prop, not a `layout-store` read here (#1605): the Elements tab can mount a `script.pre` and a
 * `script.post` row at once, and one subscription would toggle both. The host (`ScriptElementForm`)
 * seeds per-row state from the store's persisted default and writes toggles back, so the *next* row
 * opens as the user last left one while two rows on screen do not share it.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
	Card,
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
import { EmptyState } from "./EmptyState";
import { useScriptCompletionsQuery } from "@/queries";
import { countSnippets, snippetsForContext } from "@/lib/script-snippets";
import type { SnippetInsertion, SnippetPlacement } from "@/lib/editor-snippet";
import { cn } from "@/lib/utils";
import type { ScriptSnippetContext } from "@/types/domain";

export interface ScriptSnippetsProps {
	/**
	 * Which editor this list sits under; `"both"` is a script running outside any request (setup,
	 * teardown), offering only templates needing neither `pm.request` nor `pm.response`.
	 */
	context: ScriptSnippetContext;
	/** Whether the list is folded to its header. */
	collapsed: boolean;
	/** Called with the toggled value when the header is clicked. */
	onCollapsedChange: (collapsed: boolean) => void;
	/**
	 * Insert the template: the host owns the editor, so it owns insertion; this list says which
	 * template was chosen and narrates what came back.
	 */
	onInsert: (snippet: string) => SnippetInsertion | null;
}

/**
 * How each landing reads aloud, in the GraphQL explorer's `PLACEMENT_PHRASE` shape: "Inserted X
 * <phrase>."
 */
const PLACEMENT_PHRASE: Record<SnippetPlacement, string> = {
	cursor: "at the cursor",
	"end-of-script": "at the end of the script",
};

export function ScriptSnippets({
	context,
	collapsed,
	onCollapsedChange,
	onInsert,
}: ScriptSnippetsProps) {
	const { data, isPending, isError } = useScriptCompletionsQuery();

	const groups = snippetsForContext(data?.completions, context);
	const total = countSnippets(groups);

	/*
	 * What just happened, said aloud (the explorer's pattern, `GraphQLBody.tsx`): an insertion
	 * lands out of the list's sight, and a live region speaks only when its text *changes*, so the
	 * same template twice would be silent; the sequence number makes the repeat audible.
	 */
	const [announcement, setAnnouncement] = useState<{ text: string; seq: number }>({
		text: "",
		seq: 0,
	});
	const say = (text: string) => setAnnouncement((prev) => ({ text, seq: prev.seq + 1 }));

	/*
	 * The one outcome with nothing to look at: an insertion shows in the editor, but a refusal in
	 * `sr-only` text alone is, to a sighted user, a click that did nothing. Cleared by the next
	 * insertion that lands.
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
		<Collapsible open={!collapsed} onOpenChange={(open) => onCollapsedChange(!open)}>
			{/*
			 * The whole header is the control (the composite-row hit-area rule): a narrow activator
			 * in a wide bar leaves most of it hovering without acting.
			 */}
			<CollapsibleTrigger
				className={cn(
					EYEBROW_CLASS,
					"flex w-full items-center gap-1 text-left transition-colors hover:text-foreground"
				)}
			>
				{collapsed ? (
					<ChevronRight className="size-icon-sm shrink-0" />
				) : (
					<ChevronDown className="size-icon-sm shrink-0" />
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
				{/*
				 * A `Card`, not a sunken slab: `Command` declares `bg-card surface-card` itself, so
				 * a `bg-transparent` override would replace the background and leave the surface
				 * class, and the filter's `border-rule` would resolve to the card's value in a
				 * sunken box. One surface for box and contents is the only spelling where every
				 * rule reads on what it sits on.
				 */}
				<Card className="overflow-hidden">
					{isError ? (
						<p className="px-3 py-2 text-xs text-muted-foreground">
							Snippets come from Vayu's engine, which is not answering right now.
						</p>
					) : isPending ? (
						<p className="px-3 py-2 text-xs text-muted-foreground">Loading snippets…</p>
					) : total === 0 ? (
						<EmptyState
							variant="inline"
							compact
							title="No snippets for this kind of script."
						/>
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
													<span className="text-label text-muted-foreground">
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
				</Card>
			</CollapsibleContent>
		</Collapsible>
	);
}
