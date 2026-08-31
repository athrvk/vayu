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
 * is the order on screen: a promoted top result, then the fixed sections.
 */

import { useMemo } from "react";
import {
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui";
import { getMethodColor } from "@/utils";
import type { CommandContext } from "@/lib/commands";
import { PALETTE_GROUP_LABELS, type PaletteItem } from "./types";
import { rankPalette, TOP_RESULT_LABEL } from "./ranking";
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

	return (
		<>
			<span aria-live="polite" className="sr-only">
				{query ? `${total} searchable results` : `${total} results`}
			</span>
			<CommandList>
				<CommandEmpty>No matches.</CommandEmpty>
				{/* The best match across every section, lifted out of its own
				    section rather than copied into this one: two rows carrying
				    the same `value` would both read as selected. */}
				{ranked.top.length > 0 && (
					<CommandGroup heading={TOP_RESULT_LABEL}>
						{ranked.top.map((item) => (
							<PaletteRow key={item.id} item={item} onPick={onPick} />
						))}
					</CommandGroup>
				)}
				{ranked.groups.map((group, index) => (
					<div key={group.kind}>
						{(index > 0 || ranked.top.length > 0) && <CommandSeparator />}
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

function PaletteRow({ item, onPick }: { item: PaletteItem; onPick: (item: PaletteItem) => void }) {
	const Icon = item.icon;
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
		</CommandItem>
	);
}
