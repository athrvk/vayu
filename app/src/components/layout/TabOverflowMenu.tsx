/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The "+N" menu a section-tab strip sends its overflowed tabs to (#2200).
 *
 * Presentational: `useFittedTabs` decides who overflows, the strip decides what
 * choosing one means. The trigger is a sibling of the `TabsList`, never a child,
 * because a `role="tablist"` owns only tabs and a menu button inside one is
 * announced as a member of the set. It looks like `TabStrip`'s overflow trigger
 * without its left rule: that rule is `border-border`, which a card surface
 * (the response pane) paints invisible.
 */

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	TabErrorDot,
} from "@/components/ui";
import { pluralize } from "@/modules/dashboard/utils/format";

export interface OverflowedTab<Id extends string> {
	id: Id;
	label: string;
	/**
	 * What the tab's trigger would have drawn after its label - a count, a dot, a
	 * result chip. The strip passes the same node it gives the trigger, so a mark
	 * is defined once and the menu cannot drift from it.
	 */
	mark?: ReactNode;
	/**
	 * The tab holds a failure the user has to see (a script error, a failing test
	 * run). A hidden one marks the "+N" trigger itself, because the menu is closed
	 * and the item's own mark is out of sight.
	 */
	attention?: boolean;
}

/** The trigger's accessible name: the count, then which hidden tabs need a look. */
function triggerName<Id extends string>(tabs: readonly OverflowedTab<Id>[]): string {
	const flagged = tabs.filter((tab) => tab.attention).map((tab) => `, ${tab.label} has an error`);
	return `${tabs.length} more ${pluralize(tabs.length, "tab")}${flagged.join("")}`;
}

export function TabOverflowMenu<Id extends string>({
	tabs,
	onSelect,
}: {
	tabs: readonly OverflowedTab<Id>[];
	onSelect: (id: Id) => void;
}) {
	if (tabs.length === 0) return null;
	const needsAttention = tabs.some((tab) => tab.attention);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					className="flex shrink-0 items-center gap-1 px-2 text-xs font-mono text-muted-foreground hover:bg-muted/50 hover:text-foreground active:scale-[0.98]"
					aria-label={triggerName(tabs)}
				>
					+{tabs.length}
					{needsAttention && <TabErrorDot label="A hidden tab has an error" />}
					<ChevronDown className="size-icon-sm" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="max-h-80 overflow-y-auto [scrollbar-gutter:auto]"
			>
				{tabs.map((tab) => (
					<DropdownMenuItem
						key={tab.id}
						onSelect={() => onSelect(tab.id)}
						// `gap-1.5` like a trigger: an empty mark cancels that gap with
						// `-ms-1.5` (`MARK_TRACK`), so it only cancels it at this value.
						className="gap-1.5 text-xs"
					>
						{tab.label}
						{tab.mark}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
