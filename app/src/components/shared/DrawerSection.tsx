/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DrawerSection - a group of rows inside a drawer view, and its header.
 *
 * `DrawerPanel` gave the four views one frame; the groups *inside* a view still
 * had none. Services drew muted sentence-case labels with a trailing plus;
 * Variables drew a chevron, an icon, a filled `Badge` count and a plus; and the
 * collections tree wrote its counts as inline `(2)` text one click away from
 * that badge. Two count idioms for the same fact, in one drawer.
 *
 * **One count idiom: the muted inline count, in parentheses.** The filled badge
 * loses. A count beside a group name is not a status and not a control - it is
 * the least important thing in the row, and a `Badge` gives it a fill, a
 * border, a 20px floor and the visual weight of a chip. The collections tree
 * already wrote it as muted text, which is also the idiom a row inside the tree
 * can use unchanged (`DrawerSectionCount` is exported for exactly that, so a row
 * and its section cannot drift apart again).
 *
 * **The header's ARIA stays at the call site.** Variables' section headers are
 * `role="treeitem"` rows inside a roving-tabindex tree, and the "+" beside one
 * is deliberately *outside* that row - the tree has no create key, so the button
 * is the drawer's own tab stop rather than a control the keyboard cannot reach.
 * A primitive that owned those attributes would have to know about the tree, so
 * `rowProps` and `activatorProps` are spread through instead: this component
 * owns the *shape* - the padding, the type, the chevron, where the count sits
 * and where the actions sit - and the caller keeps the semantics.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** Attributes a caller spreads onto the header row or its activator. */
type PassedProps<T> = React.HTMLAttributes<T> & {
	[key: `data-${string}`]: string | number | boolean | undefined;
	[key: `aria-${string}`]: string | number | boolean | undefined;
	tabIndex?: number;
	role?: string;
	type?: "button";
};

/** The header's own type: muted, small, and never louder than the rows under it. */
const HEADER_TEXT = "text-xs tracking-wider text-muted-foreground";

/**
 * The one count idiom. Exported so a row inside a section (the collection tree's
 * folder rows) writes it the same way its section header does.
 *
 * `shrink-0`: the count is short and load-bearing, so the name yields first.
 */
export function DrawerSectionCount({
	value,
	className,
}: {
	value: number | string;
	className?: string;
}) {
	return (
		<span className={cn("shrink-0 text-xs tabular-nums text-muted-foreground", className)}>
			({value})
		</span>
	);
}

interface DrawerSectionProps {
	title: string;
	/** A glyph for the scope the section names - Variables' cloud and layers. */
	icon?: LucideIcon;
	/**
	 * How many rows are inside. A string for a count the app does not have yet:
	 * Variables passes `"-"` while the query is loading or has failed, because a
	 * literal `0` beside "Couldn't load collections" asserts something untrue.
	 */
	count?: number | string;
	/** Trailing controls - the group's own "New …" button. */
	actions?: ReactNode;
	/**
	 * Collapse state. Both together make the header a button with a chevron;
	 * omitted, the header is a plain heading.
	 */
	expanded?: boolean;
	onToggle?: () => void;
	/** Spread onto the element holding the header's title - a `treeitem` row. */
	rowProps?: PassedProps<HTMLDivElement>;
	/** Spread onto the activator button. Only read when `onToggle` is given. */
	activatorProps?: PassedProps<HTMLButtonElement>;
	children?: ReactNode;
	className?: string;
}

export function DrawerSection({
	title,
	icon: Icon,
	count,
	actions,
	expanded,
	onToggle,
	rowProps,
	activatorProps,
	children,
	className,
}: DrawerSectionProps) {
	const collapsible = typeof onToggle === "function";
	const Chevron = expanded ? ChevronDown : ChevronRight;

	const heading = collapsible ? (
		<button
			type="button"
			{...activatorProps}
			onClick={onToggle}
			// px-3 py-1.5 on the activator, not on the row: the header's hover fill
			// has to reach the row's edges, and a button inset inside a padded row
			// leaves a dead strip on both sides (the composite-row hit-area trap
			// drawer-row-hit-area.test.tsx was written against).
			className={cn(
				"flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left hover:bg-accent",
				HEADER_TEXT,
				activatorProps?.className
			)}
		>
			<Chevron className="size-icon-sm shrink-0" aria-hidden="true" />
			{Icon && <Icon className="size-icon-sm shrink-0" aria-hidden="true" />}
			<span className="truncate">{title}</span>
			{count !== undefined && <DrawerSectionCount value={count} className="ml-auto" />}
		</button>
	) : (
		<h3 className={cn("flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5", HEADER_TEXT)}>
			{Icon && <Icon className="size-icon-sm shrink-0" aria-hidden="true" />}
			<span className="truncate">{title}</span>
			{count !== undefined && <DrawerSectionCount value={count} className="ml-auto" />}
		</h3>
	);

	return (
		<section className={cn("mb-4", className)}>
			{/* `pr-3` matches the leading `px-3` on the heading, so the actions stop
			    where the rows' own padding does. */}
			<div className="flex items-center gap-1 pr-3">
				{rowProps ? (
					<div {...rowProps} className={cn("flex min-w-0 flex-1", rowProps.className)}>
						{heading}
					</div>
				) : (
					heading
				)}
				{actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
			</div>
			{children}
		</section>
	);
}
