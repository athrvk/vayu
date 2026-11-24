/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a row's actions are and how one is drawn, once for both menus: the `⋯` button
 * (`RowActionsMenu`) and right-click (`RowContextMenu`, #1360) are different Radix families with
 * different item elements, but one list, and its rules (where the destructive separator falls, what
 * a destructive item looks like) are stated here so neither copy drifts. What an item *contains* is
 * `RowActionBody`, a file over, as a module exporting a component and helpers loses fast refresh.
 */

import type { LucideIcon } from "lucide-react";
import type { IconMotion } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface RowAction {
	label: string;
	icon: LucideIcon;
	/**
	 * The named icon motion the glyph answers this item's hover with (`ICON_MOTION`,
	 * `docs/design-system/motion.md` → Motion → Icon motion); optional, as most actions have
	 * nothing to animate. Declared here as the item is drawn once for both menus.
	 */
	iconMotion?: IconMotion;
	onSelect: () => void;
	/**
	 * The action opens a field that focuses on mount (Rename, Add collection): run once the menu
	 * has closed, not from `onSelect`, as focus claimed while the menu closes is taken back
	 * (`useAfterMenuClose`, #3443).
	 */
	opensField?: boolean;
	/** Renders in destructive colour and is separated from the actions above. */
	destructive?: boolean;
	disabled?: boolean;
	/**
	 * Why the item is off ("Already first"), drawn beside the label by `RowActionBody` in both
	 * menus. Not a `DisabledHint` (`components/ui/disabled-hint.tsx`), every *other* gated
	 * control's primitive: its wrapper span's own tab stop would compete with the menu's focus
	 * management, as Radix owns the keyboard there and skips disabled items. A menu row has room,
	 * so the reason reads on the row without hovering.
	 */
	disabledReason?: string;
	/**
	 * A value the item carries beside its label (the URL a Copy would put on the clipboard), in
	 * `disabledReason`'s trailing column. On the row, not in a tooltip on an always-visible icon
	 * button, which reads only on hover, only with a pointer and only while it stays; here a screen
	 * reader reaches it in the item's name.
	 */
	hint?: string;
}

/** One action, plus whether a separator belongs above it. */
export interface RowActionRow {
	action: RowAction;
	separatorBefore: boolean;
}

/**
 * The actions in order with the one grouping rule applied: the first destructive action is fenced
 * off from the ordinary ones above, and a menu destructive from its first item needs no fence.
 */
export function rowActionRows(actions: RowAction[]): RowActionRow[] {
	const firstDestructive = actions.findIndex((a) => a.destructive);
	return actions.map((action, i) => ({
		action,
		separatorBefore: Boolean(action.destructive) && i === firstDestructive && i > 0,
	}));
}

/**
 * The classes an item takes in either menu. `group` is here, not at call sites: an icon motion
 * fires from its owner's `:hover`/`:focus-visible`, a menu item is no `[data-slot="button"]`, and
 * one menu would otherwise lack it.
 */
export function rowActionItemClass(action: RowAction): string {
	return cn("group gap-2 text-sm", action.destructive && "text-destructive-text");
}

/**
 * A control costing its row no width until the row is hovered or focused. `opacity-0` keeps the
 * space (a hover-revealed pin and delete took 52px of the 260px history drawer from every name),
 * and `hidden` leaves the tab order. Collapsed it is `absolute`: out of the flex flow (no width, no
 * gap) but focusable, pinned to the trailing corner so it adds no overflow. A focused control makes
 * the row `:focus-within`, returning it to the flow, so a keyboard user never lands on an absent
 * control. `static`, not `relative`, on reveal: a flex item takes `z-index` unpositioned, so a
 * cluster's `z-10` over a stretched activator holds. `hover: none` devices never match
 * `group-hover` and keep it shown. The row is the `group` and must be positioned; a row whose
 * actions are never hidden (a state toggle) does not take this.
 */
export const ROW_ACTIONS_REVEAL = [
	"pointer-events-none absolute right-0 top-0 opacity-0 transition-opacity",
	"group-hover:pointer-events-auto group-hover:static group-hover:opacity-100",
	"group-focus-within:pointer-events-auto group-focus-within:static group-focus-within:opacity-100",
	"[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:static [@media(hover:none)]:opacity-100",
].join(" ");
