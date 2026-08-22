/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

"use client";

import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import { cn } from "@/lib/utils";

function ScrollArea({
	className,
	children,
	...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
	return (
		<ScrollAreaPrimitive.Root
			data-slot="scroll-area"
			className={cn("relative overflow-hidden", className)}
			{...props}
		>
			<ScrollAreaPrimitive.Viewport className="h-full w-full">
				{children}
			</ScrollAreaPrimitive.Viewport>
			<ScrollBar />
			<ScrollAreaPrimitive.Corner />
		</ScrollAreaPrimitive.Root>
	);
}

/**
 * The overlay scrollbar, sized and coloured to match the native one.
 *
 * A `ScrollArea` sits beside plain `overflow-auto` panes all over the app, so
 * its bar is read against theirs: this is 6px because `::-webkit-scrollbar` in
 * `index.css` is 6px, and it carries the same `muted-foreground/30` thumb for
 * the same reason. It shipped at shadcn's 10px with a `bg-border` thumb, which
 * is both thicker than the baseline and - since `--border` matches `--card` in
 * dark - invisible on the surface this component is usually laid over.
 *
 * The 1px padding and transparent edge border shadcn insets the thumb with are
 * gone with the width: they were a 30% inset on a 10px bar and would be a 50%
 * one here, leaving a 3px thumb inside a 6px gutter.
 */
function ScrollBar({
	className,
	orientation = "vertical",
	...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
	return (
		<ScrollAreaPrimitive.ScrollAreaScrollbar
			data-slot="scroll-area-scrollbar"
			orientation={orientation}
			className={cn(
				"flex touch-none select-none transition-colors",
				orientation === "vertical" && "h-full w-1.5",
				orientation === "horizontal" && "h-1.5 flex-col",
				className
			)}
			{...props}
		>
			<ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-muted-foreground/30 hover:bg-muted-foreground/50" />
		</ScrollAreaPrimitive.ScrollAreaScrollbar>
	);
}

export { ScrollArea, ScrollBar };
