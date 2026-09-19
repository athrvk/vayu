/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a row's actions are, and how one is drawn - once, for both menus.
 *
 * A row exposes the same list two ways: the `⋯` button (`RowActionsMenu`) and
 * right-click (`RowContextMenu`, #1360). They are different Radix families, so
 * the item element differs, but the list is one list and the rules about it -
 * where the destructive separator falls, what a destructive item looks like -
 * are stated here rather than once per menu. A second copy would be free to
 * drift, and the one that drifted would be whichever the next reader did not
 * open. What an item *contains* is `RowActionBody`, a file over, because a
 * module that exports a component and helpers loses fast refresh.
 */

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface RowAction {
	label: string;
	icon: LucideIcon;
	onSelect: () => void;
	/** Renders in destructive colour and is separated from the actions above. */
	destructive?: boolean;
	disabled?: boolean;
	/**
	 * Why the item is off, e.g. "Already first" - drawn beside the label by
	 * `RowActionBody`, for both menus at once.
	 *
	 * Not a `DisabledHint` (`components/ui/disabled-hint.tsx`), which is the
	 * primitive for every *other* gated control: that one works by giving a
	 * wrapper span its own tab stop, and inside a menu that second stop competes
	 * with the menu's own focus management - Radix owns the keyboard there, and
	 * a disabled item is deliberately skipped by it. A menu row has horizontal
	 * space a button does not, so the reason can simply be on the row, where it
	 * is readable without hovering anything.
	 */
	disabledReason?: string;
	/**
	 * A value the item carries beside its label - the URL a Copy would put on
	 * the clipboard - drawn in the same trailing column as `disabledReason`.
	 *
	 * The alternative was a tooltip on an always-visible icon button, which is
	 * what the Services rows had: it read only on hover, only with a pointer,
	 * and only for as long as the pointer stayed. In a menu the value is simply
	 * on the row, where a screen reader reaches it in the item's own name.
	 */
	hint?: string;
}

/** One action, plus whether a separator belongs above it. */
export interface RowActionRow {
	action: RowAction;
	separatorBefore: boolean;
}

/**
 * The actions in order, with the one rule about their grouping applied: the
 * first destructive action is fenced off from the ordinary ones above it, and
 * a menu that is destructive from its first item needs no fence.
 */
export function rowActionRows(actions: RowAction[]): RowActionRow[] {
	const firstDestructive = actions.findIndex((a) => a.destructive);
	return actions.map((action, i) => ({
		action,
		separatorBefore: Boolean(action.destructive) && i === firstDestructive && i > 0,
	}));
}

/** The classes an item takes, whichever menu is drawing it. */
export function rowActionItemClass(action: RowAction): string {
	return cn("gap-2 text-sm", action.destructive && "text-destructive-text");
}
