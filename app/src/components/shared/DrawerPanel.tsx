/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The frame every drawer view sits in, so switching views changes the content and nothing else (the
 * content's start and the title's presence had drifted between views). The frame owns the header
 * padding; the body is flush so rows run edge to edge (the sidebar convention, giving back ~32px of
 * row width) and bring their own padding. **The header is the drawer's half of the second chrome
 * row**: it sizes to `--tabstrip-height` with the tab strip's bottom rule, reading as one band
 * across the window. That is why the height is a token, not `h-8`: the strip must agree, and the
 * two files cannot see each other.
 */

import { cn } from "@/lib/utils";

interface DrawerPanelProps {
	/** Names the panel. Every view has one, so the drawer never loses its title. */
	title: string;
	/** Trailing header controls - add, import, counts. */
	actions?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
}

export function DrawerPanel({ title, actions, children, className }: DrawerPanelProps) {
	return (
		<div className={cn("flex h-full w-full flex-col", className)}>
			{/* The only padded region; one height for every view keeps the body's start fixed. */}
			<div className="flex h-[var(--tabstrip-height)] shrink-0 items-center justify-between gap-2 border-b border-border px-3">
				<h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
				{actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
			</div>
			{/*
			 * Flush: rows run edge to edge with their own padding, and the panel owns scrolling so
			 * every view scrolls alike. `overflow-x-hidden` is explicit: `overflow-y: auto` makes
			 * overflow-x `auto` too, so one over-wide row would scroll the drawer sideways; rows
			 * ellipse instead (TruncatedText). `data-drawer-body` names the scrolling box for a
			 * view scrolling it itself (the collection tree's drag auto-scroll); an attribute, not
			 * a ref prop, as the frame need not know which views want one.
			 */}
			<div data-drawer-body className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
				{children}
			</div>
		</div>
	);
}
