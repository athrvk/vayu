/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The palette's list: every source, grouped and ranked.
 *
 * Mounted only while the palette is open - the same cost model the context
 * bar's sections use. The sources read collections, requests, settings,
 * variables and run history, and a palette that is shut has no business holding
 * query observers on any of it.
 *
 * Two shapes of source meet here. The shallow ones return everything they know
 * and let the ranking narrow it; the deep ones (settings, variables, runs)
 * search corpora too large to render - so they take the query, rank and cap it
 * themselves, and offer an escape row into the surface that browses the rest.
 *
 * What this file does *not* do is match. `ranking.ts` decides what renders and
 * in what order, once, and the palette tells cmdk not to score anything a
 * second time (`shouldFilter={false}` in `CommandPalette`). So the order below
 * is the order on screen: the lead sections the ranking lifted rows into - a
 * promoted top result when something is typed, Recents and the verbs when
 * nothing is, the verbs again when what was typed matched nothing - and then
 * the fixed sections.
 */

import { useMemo } from "react";
import { CommandGroup, CommandItem, CommandList, CommandSeparator, Kbd } from "@/components/ui";
import { formatRelativeTime, getMethodColor } from "@/utils";
import { chordKeys } from "@/lib/platform";
import type { CommandContext } from "@/lib/commands";
import { PALETTE_GROUP_LABELS, type PaletteItem } from "./types";
import { QUICK_ACTIONS_LABEL, RECENTS_LABEL, rankPalette, TOP_RESULT_LABEL } from "./ranking";
import { useTabItems } from "./sources/useTabItems";
import { useEntityItems } from "./sources/useEntityItems";
import { useViewItems } from "./sources/useViewItems";
import { commandItems } from "./sources/commandItems";
import { useSettingsItems } from "./sources/useSettingsItems";
import { useVariableItems } from "./sources/useVariableItems";
import { useRunItems } from "./sources/useRunItems";

interface PaletteResultsProps {
	/** The live query, so ranking can tell "nothing typed" from "no match". */
	query: string;
	/** Run the item and close - the palette never stays open after a pick. */
	onPick: (item: PaletteItem) => void;
	/**
	 * What the commands can see. Built by the palette rather than here, because
	 * the dialogs it carries have to outlive the list: picking "Run" closes the
	 * palette, and this component with it.
	 */
	commandContext: CommandContext;
}

export function PaletteResults({ query, onPick, commandContext }: PaletteResultsProps) {
	const tabs = useTabItems();
	const entities = useEntityItems();
	const views = useViewItems();
	const commands = commandItems(commandContext);
	const settings = useSettingsItems(query);
	const variables = useVariableItems(query);
	const runs = useRunItems(query);

	const ranked = useMemo(
		() =>
			rankPalette(
				[...tabs, ...entities, ...views, ...commands, ...settings, ...variables, ...runs],
				query
			),
		[tabs, entities, views, commands, settings, variables, runs, query]
	);

	/*
	 * The count is exact because the ranking decided it: every row it kept is a
	 * row this renders, so nothing can hide one afterwards. `aria-live="polite"`
	 * on an sr-only line is the announcement - a listbox that silently swaps its
	 * contents as you type tells a screen-reader user nothing about whether the
	 * query narrowed anything.
	 */
	const { total } = ranked;

	/*
	 * The sections above the fixed order, in the order they render. Each holds
	 * rows lifted out of the sections below rather than copied into it - two
	 * rows carrying the same `value` would both read as selected - so no row
	 * reaches this list twice. The top result answers a typed query and Recents
	 * and the verbs both answer an empty one, so the two of them do render
	 * together; a row that qualifies for both belongs to Recents, the earlier
	 * section, and `ranking.ts` has already taken it out of the other.
	 */
	const lead: LeadSection[] = [
		{ key: "top", heading: TOP_RESULT_LABEL, items: ranked.top },
		{ key: "recents", heading: RECENTS_LABEL, items: ranked.recents, withRecency: true },
		{ key: "quick-actions", heading: QUICK_ACTIONS_LABEL, items: ranked.quickActions },
	].filter((section) => section.items.length > 0);

	/*
	 * Nothing the query could match. The ranking answers that by handing back
	 * the verbs (#1177), so the line below introduces them rather than ending
	 * the palette on "No matches."
	 *
	 * It is a line of its own rather than either primitive for the job, and
	 * both were considered: cmdk's `CommandEmpty` renders only when the list
	 * has no rows at all, and the verbs under this are rows; `EmptyState`'s
	 * `inline` variant is a centred `p-8` block that owns the space it sits in,
	 * and overriding it to a tight left-aligned lead-in would leave nothing of
	 * it but `text-sm text-muted-foreground`. This is not an empty state - the
	 * list below it is full.
	 */
	const nothingMatched = query.trim() !== "" && total === 0;

	return (
		<>
			<span aria-live="polite" className="sr-only">
				{query ? `${total} searchable results` : `${total} results`}
			</span>
			{/* The list caps itself at 400px, and at 60vh before that: about
			    eleven rows where the primitive's 300px showed six, and never
			    more than the dialog panel's own 85vh has room for once the
			    input and the hints are counted (#1177). */}
			<CommandList className="max-h-[min(400px,60vh)]">
				{nothingMatched && (
					<p className="px-3 pb-1 pt-3 text-sm text-muted-foreground">
						No matches for “{query.trim()}”. Try one of these:
					</p>
				)}
				{lead.map((section, index) => (
					<div key={section.key}>
						{index > 0 && <CommandSeparator />}
						<CommandGroup heading={section.heading}>
							{section.items.map((item) => (
								<PaletteRow
									key={item.id}
									item={item}
									onPick={onPick}
									showRecency={section.withRecency}
								/>
							))}
						</CommandGroup>
					</div>
				))}
				{ranked.groups.map((group, index) => (
					<div key={group.kind}>
						{(index > 0 || lead.length > 0) && <CommandSeparator />}
						<CommandGroup heading={PALETTE_GROUP_LABELS[group.kind]}>
							{group.items.map((item) => (
								<PaletteRow key={item.id} item={item} onPick={onPick} />
							))}
						</CommandGroup>
						{/* Its own group, not the last row of the one above: an
						    escape row leaves the palette, and reads as an aside
						    to the section rather than the least of its results. */}
						{group.escapes.length > 0 && (
							<CommandGroup>
								{group.escapes.map((item) => (
									<PaletteRow key={item.id} item={item} onPick={onPick} />
								))}
							</CommandGroup>
						)}
					</div>
				))}
			</CommandList>
		</>
	);
}

/** One of the sections that render above the fixed group order. */
interface LeadSection {
	key: string;
	heading: string;
	items: PaletteItem[];
	/** Print each row's age. Only Recents, where the age is the reason it is there. */
	withRecency?: boolean;
}

function PaletteRow({
	item,
	onPick,
	showRecency = false,
}: {
	item: PaletteItem;
	onPick: (item: PaletteItem) => void;
	showRecency?: boolean;
}) {
	const Icon = item.icon;
	// Only where the section asked for it *and* the row knows one: a row with no
	// recency in Recents cannot happen (that is what put it there), and the
	// check is what keeps it from printing an epoch date if it ever did.
	const recency =
		showRecency && item.recencyAt !== undefined && formatRelativeTime(item.recencyAt);
	return (
		<CommandItem
			// cmdk no longer matches on these - `ranking.ts` does, against the
			// same two fields - but `value` is still how cmdk tells one row from
			// another for selection and keyboard navigation, so it stays what
			// the row *reads* as.
			value={[item.title, item.subtitle].filter(Boolean).join(" ")}
			keywords={item.keywords}
			onSelect={() => onPick(item)}
			className="gap-2"
		>
			{item.method && (
				<span
					aria-hidden="true"
					// The same 2px rail the tab strip draws, for the same reason:
					// the method is a colour everywhere else in the app.
					className="h-3.5 w-0.5 shrink-0 rounded-full"
					style={{ background: `hsl(${getMethodColor(item.method)})` }}
				/>
			)}
			{Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
			<span className="min-w-0 flex-1 truncate">{item.title}</span>
			{item.subtitle && (
				<span className="ml-auto shrink-0 truncate pl-3 text-xs text-muted-foreground">
					{item.subtitle}
				</span>
			)}
			{/* One of the two trailing slots below draws, never both, and the
			    chord is the one that wins: a stamp is why a row is in Recents,
			    but the chord is how the row is run, and how to run it outlasts
			    when it last was. The recency carries the guard because it is
			    the slot that yields. Both at once would print `⌘K  2m ago` with
			    the spacing of neither - each carries `ml-auto`, so the second
			    no longer pushes right (#1260). No source stamps a command row
			    today; #1197 made one survivable by keeping such a row out of
			    two sections at once, and this is the same premise held here.

			    One cap per key, the `Kbd` docstring's own chord form, drawn from
			    the chord the handler matches rather than a second spelling of
			    it (#938). A row without a bound chord prints nothing: an empty
			    slot is honest, a made-up key is not. */}
			{item.shortcut && (
				<span className="ml-auto flex shrink-0 items-center gap-1 pl-3">
					{chordKeys(item.shortcut).map((cap) => (
						<Kbd key={cap} size="sm">
							{cap}
						</Kbd>
					))}
				</span>
			)}
			{recency && !item.shortcut && (
				<span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">
					{recency}
				</span>
			)}
		</CommandItem>
	);
}
