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
 * bar's sections use. The sources read collections, requests and run history,
 * and a palette that is shut has no business holding query observers on any of
 * it.
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
import { PALETTE_GROUPS, PALETTE_GROUP_LABELS, rankForEmptyQuery, type PaletteItem } from "./types";
import { useTabItems } from "./sources/useTabItems";
import { useEntityItems } from "./sources/useEntityItems";
import { useViewItems } from "./sources/useViewItems";
import { commandItems } from "./sources/commandItems";

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

	const grouped = useMemo(() => {
		const all = [...tabs, ...entities, ...views, ...commands];
		return PALETTE_GROUPS.map((kind) => ({
			kind,
			items: rankForEmptyQuery(all.filter((item) => item.kind === kind)),
		})).filter((group) => group.items.length > 0);
	}, [tabs, entities, views, commands]);

	/*
	 * cmdk hides a group whose items all filter out, so the count has to come
	 * from the rendered list rather than from `grouped`. `aria-live="polite"`
	 * on an sr-only line is the announcement: a listbox that silently swaps its
	 * contents as you type tells a screen-reader user nothing about whether the
	 * query narrowed anything.
	 */
	const total = grouped.reduce((n, group) => n + group.items.length, 0);

	return (
		<>
			<span aria-live="polite" className="sr-only">
				{query ? `${total} searchable results` : `${total} results`}
			</span>
			<CommandList>
				<CommandEmpty>No matches.</CommandEmpty>
				{grouped.map((group, index) => (
					<div key={group.kind}>
						{index > 0 && <CommandSeparator />}
						<CommandGroup heading={PALETTE_GROUP_LABELS[group.kind]}>
							{group.items.map((item) => (
								<PaletteRow key={item.id} item={item} onPick={onPick} />
							))}
						</CommandGroup>
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
			// cmdk matches against `value` plus `keywords`, so the value is what
			// the row *reads* as and the keywords are what else should find it.
			// The id is deliberately not in either: it is a uuid, and a query of
			// "b7" would then match rows at random.
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
