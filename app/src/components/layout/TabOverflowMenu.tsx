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

import { ChevronDown } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui";

export interface OverflowedTab<Id extends string> {
	id: Id;
	label: string;
}

export function TabOverflowMenu<Id extends string>({
	tabs,
	onSelect,
}: {
	tabs: readonly OverflowedTab<Id>[];
	onSelect: (id: Id) => void;
}) {
	if (tabs.length === 0) return null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					className="flex shrink-0 items-center gap-1 px-2 text-xs font-mono text-muted-foreground hover:bg-muted/50 hover:text-foreground active:scale-[0.98]"
					aria-label={`${tabs.length} more tabs`}
				>
					+{tabs.length}
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
						className="text-xs"
					>
						{tab.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
