/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DrawerPanel
 *
 * The frame every drawer view sits in, so switching views changes the content
 * and nothing else.
 *
 * The four views had drifted into two different panel designs: Collections and
 * History used a 16px padded container with a heading, while Variables and
 * Settings were flush with no heading at all. Switching views therefore moved
 * the content's vertical start *and* made the title appear or vanish.
 *
 * The frame owns the header padding; the body is deliberately flush so rows can
 * run edge to edge — the sidebar convention, and it buys back the ~32px of row
 * width the old inset cost. Rows supply their own internal padding.
 */

import { cn } from "@/lib/utils";

interface DrawerPanelProps {
	/** Names the panel. Every view has one, so the drawer never loses its title. */
	title: string;
	/** Trailing header controls — add, import, counts. */
	actions?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
}

export function DrawerPanel({ title, actions, children, className }: DrawerPanelProps) {
	return (
		<div className={cn("flex h-full w-full flex-col", className)}>
			{/* Header is the only padded region; h-10 keeps the body starting at the
			    same offset in every view. */}
			<div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
				<h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
				{actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
			</div>
			{/* Flush: rows run edge to edge and bring their own padding. The panel
			    owns scrolling so every view scrolls the same way — views used to
			    differ, some wrapped by the Drawer and some managing their own. */}
			<div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
		</div>
	);
}
