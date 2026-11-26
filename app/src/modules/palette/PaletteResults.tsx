/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The palette's list: every source, grouped and ranked.
 *
 * Mounted only while the palette is open (the context bar sections' cost model): the sources read
 * collections, requests, settings, variables and run history, and a shut palette holds no query
 * observers on any of it.
 *
 * Two shapes of source meet here. The shallow ones return everything they know and let the ranking
 * narrow it; the deep ones (settings, variables, runs) search corpora too large to render, so they
 * take the query, rank and cap it themselves, and offer an escape row into the surface that browses
 * the rest.
 *
 * This file does not match: `ranking.ts` decides what renders and in what order, once, and the
 * palette tells cmdk not to score again (`shouldFilter={false}` in `CommandPalette`). So the order
 * below is the order on screen: the lead sections the ranking lifted rows into (a promoted top
 * result when something is typed, Recents and the verbs when nothing is, the verbs again when the
 * query matched nothing), then the fixed sections.
 */

import { useLayoutEffect, useMemo } from "react";
import { CommandGroup, CommandItem, CommandList, CommandSeparator, Kbd } from "@/components/ui";
import { pluralize } from "@/modules/dashboard/utils/format";
import { TimeValue } from "@/components/shared/TimeValue";
import { TruncatedText } from "@/components/shared/TruncatedText";
import { getMethodColor } from "@/lib/method-display";
import { formatNumber } from "@/lib/format-number";
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
	 * What the commands can see. Built by the palette, not here: the dialogs it carries outlive the
	 * list, since picking "Run" closes the palette and this component with it.
	 */
	commandContext: CommandContext;
	/**
	 * The query matched nothing, so the rows are suggestions; the palette then keeps Enter from
	 * running one nobody chose. Reported from here, where the ranking is.
	 */
	onNothingMatchedChange: (nothingMatched: boolean) => void;
}

export function PaletteResults({
	query,
	onPick,
	commandContext,
	onNothingMatchedChange,
}: PaletteResultsProps) {
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
	 * The count is exact because the ranking decided it: every kept row renders here or is counted
	 * by a capped group's "N more" line, so nothing is dropped unannounced. `aria-live="polite"` on
	 * an sr-only line is the announcement: a listbox that silently swaps its rows tells a
	 * screen-reader user nothing about whether the query narrowed anything.
	 */
	const { total } = ranked;

	/*
	 * The sections above the fixed order, in render order. Each holds rows lifted out of the
	 * sections below, not copied (two rows with one `value` would both read as selected), so no row
	 * appears twice. The top result answers a typed query, Recents and the verbs an empty one, so
	 * those two do render together; a row that qualifies for both belongs to Recents, the earlier
	 * section, and `ranking.ts` has already removed it from the other.
	 */
	const lead: LeadSection[] = [
		{ key: "top", heading: TOP_RESULT_LABEL, items: ranked.top },
		{ key: "recents", heading: RECENTS_LABEL, items: ranked.recents, withRecency: true },
		{ key: "quick-actions", heading: QUICK_ACTIONS_LABEL, items: ranked.quickActions },
	].filter((section) => section.items.length > 0);

	/*
	 * Nothing the query could match: the ranking hands back the verbs (#1177), so this line
	 * introduces them rather than ending on "No matches."
	 *
	 * A line of its own, not a primitive, and both were considered: cmdk's `CommandEmpty` renders
	 * only when the list has no rows, and the verbs under it are rows; `EmptyState`'s `inline`
	 * variant is a centred `p-8` block that owns its space, and overriding it to a tight
	 * left-aligned lead-in would leave nothing of it but `text-sm text-muted-foreground`. The list
	 * below is full; this is not an empty state.
	 *
	 * The verbs are an offer, not an answer: `CommandPalette` keeps them unhighlighted until the
	 * user moves to one, so Enter on a miss does nothing (#3321). It learns of this state from
	 * `onNothingMatchedChange`.
	 */
	const nothingMatched = query.trim() !== "" && total === 0;

	/*
	 * A layout effect, so the highlight is withheld before the frame that would show the first
	 * suggestion lit. The cleanup clears it when the palette closes and the list unmounts.
	 */
	useLayoutEffect(() => {
		onNothingMatchedChange(nothingMatched);
		return () => onNothingMatchedChange(false);
	}, [nothingMatched, onNothingMatchedChange]);

	return (
		<>
			<span aria-live="polite" className="sr-only">
				{query
					? `${total} searchable ${pluralize(total, "result")}`
					: `${total} ${pluralize(total, "result")}`}
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
							{group.hidden > 0 && <HiddenRowsHint count={group.hidden} />}
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

/**
 * What a capped group says about the rows it did not render (#2545): a plain element, not a
 * disabled `CommandItem`, because cmdk navigates and selects only its items, so this is out of
 * reach of the arrows and Enter without a disabled state, and mounts no per-item effect.
 */
function HiddenRowsHint({ count }: { count: number }) {
	return (
		<p className="px-2 py-1.5 text-xs text-muted-foreground">
			{formatNumber(count)} more - keep typing
		</p>
	);
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
	// Only where the section asked *and* the row knows one: a Recents row always has a recency
	// (that put it there), and the check keeps an epoch date off the row if one ever did not.
	const recencyAt = showRecency ? item.recencyAt : undefined;
	return (
		<CommandItem
			// cmdk does not match on these (`ranking.ts` does, on the same two fields), but `value`
			// is how cmdk tells rows apart for selection and keyboard navigation, so it stays what
			// the row reads as.
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
					className="h-icon-sm w-0.5 shrink-0 rounded-full"
					style={{ background: `hsl(${getMethodColor(item.method)})` }}
				/>
			)}
			{Icon && <Icon className="size-icon-sm shrink-0 text-muted-foreground" />}
			{/* The title is what the user searched for, so it keeps a floor, and the
			    subtitle (a collection path, often the longer of the two) gives way
			    at half the row. A `shrink-0` subtitle never truncated: it took the
			    whole row and left the title nothing (#3495). */}
			<TruncatedText className="min-w-[12ch] flex-1">{item.title}</TruncatedText>
			{item.subtitle && (
				<TruncatedText className="ml-auto min-w-0 max-w-[50%] pl-3 text-xs text-muted-foreground">
					{item.subtitle}
				</TruncatedText>
			)}
			{/*
			 * One of the two trailing slots draws, never both, and the chord wins: a stamp is why a
			 * row is in Recents, but the chord is how the row runs, and that outlasts when it last
			 * ran. The recency carries the guard because it is the slot that yields. Both would
			 * print `⌘K  2m ago` with the spacing of neither: each carries `ml-auto`, so the second
			 * no longer pushes right (#1260). No source stamps a command row today; #1197 made one
			 * survivable by keeping such a row out of two sections, and this holds the same
			 * premise.
			 *
			 * One cap per key, the `Kbd` docstring's chord form, drawn from the chord the handler
			 * matches rather than a second spelling of it (#938). A row without a bound chord
			 * prints nothing: an empty slot is honest, a made-up key is not.
			 */}
			{item.shortcut && (
				<span className="ml-auto flex shrink-0 items-center gap-1 pl-3">
					{chordKeys(item.shortcut).map((cap) => (
						<Kbd key={cap} size="sm">
							{cap}
						</Kbd>
					))}
				</span>
			)}
			{recencyAt !== undefined && !item.shortcut && (
				<TimeValue
					value={recencyAt}
					style="relative"
					className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground"
				/>
			)}
		</CommandItem>
	);
}
