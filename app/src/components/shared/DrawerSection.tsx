/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A group of rows inside a drawer view, and its header: `DrawerPanel` gives the views one frame,
 * this the groups inside one. **One count idiom: the muted inline count, in parentheses**, not a
 * filled `Badge`: a count beside a group name is neither status nor control but the least important
 * thing in the row, and a `Badge` gives it a fill, border, 20px floor and a chip's weight. The
 * collection tree's rows use it too (`DrawerSectionCount` is exported for that), so a row and its
 * section cannot drift. **The header's ARIA stays at the call site**: Variables' headers are
 * `role="treeitem"` rows in a roving-tabindex tree, with the "+" deliberately *outside* the row
 * (the tree has no create key, so the button is its own tab stop). A primitive owning those would
 * have to know the tree, so `rowProps` and `activatorProps` spread through: this owns the *shape*
 * (padding, type, chevron, where count and actions sit), the caller the semantics.
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
 * The one count idiom, exported so a row in a section (the collection tree's folder rows) writes it
 * as its header does. A root folder counts every request in its subtree (folders not counted, as
 * the import preview does); a nested folder its direct children, requests and folders. `shrink-0`:
 * the count is short and load-bearing, so the name yields first.
 */
export function DrawerSectionCount({
	value,
	className,
}: {
	value: number | string;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"cap-centred shrink-0 text-xs tabular-nums text-muted-foreground",
				className
			)}
		>
			({value})
		</span>
	);
}

interface DrawerSectionProps {
	title: string;
	/** A glyph for the scope the section names - Variables' cloud and layers. */
	icon?: LucideIcon;
	/**
	 * How many rows are inside; a string for a count not yet known: Variables passes `"-"` while
	 * loading or failed, as a `0` beside "Couldn't load collections" is untrue.
	 */
	count?: number | string;
	/** Trailing controls - the group's own "New …" button. */
	actions?: ReactNode;
	/**
	 * Collapse state: with `onToggle`, the header is a button with a chevron; omitted, a plain
	 * heading.
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
			// px-3 py-1.5 on the activator, not the row: the hover fill must reach the row's edges,
			// and a button inset in a padded row leaves dead strips (the composite-row hit-area
			// trap drawer-row-hit-area.test.tsx guards).
			className={cn(
				"flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left hover:bg-accent",
				HEADER_TEXT,
				activatorProps?.className
			)}
		>
			<Chevron className="size-icon-sm shrink-0" aria-hidden="true" />
			{Icon && <Icon className="size-icon-sm shrink-0" aria-hidden="true" />}
			<span className="cap-centred truncate">{title}</span>
			{count !== undefined && <DrawerSectionCount value={count} className="ml-auto" />}
		</button>
	) : (
		<h3 className={cn("flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5", HEADER_TEXT)}>
			{Icon && <Icon className="size-icon-sm shrink-0" aria-hidden="true" />}
			<span className="cap-centred truncate">{title}</span>
			{count !== undefined && <DrawerSectionCount value={count} className="ml-auto" />}
		</h3>
	);

	return (
		<section className={cn("mb-4", className)}>
			{/*
			 * `pr-3` matches the heading's `px-3`, so the actions stop where the rows' padding
			 * does.
			 */}
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
