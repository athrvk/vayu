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
 * The overlay scrollbar, matching the native one it sits beside in plain `overflow-auto` panes:
 * `w-2`/`h-2`, as `index.css`'s `::-webkit-scrollbar` is (2 spacing units, 6px at default density),
 * with the same `muted-foreground/30` thumb. Shadcn's `bg-border` thumb would be invisible in dark,
 * where `--border` matches `--card`. Its 1px padding and transparent inset border are dropped too:
 * a 50% inset on this width, a 3px thumb in a 6px gutter.
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
				orientation === "vertical" && "h-full w-2",
				orientation === "horizontal" && "h-2 flex-col",
				className
			)}
			{...props}
		>
			{/*
			 * `transition-colors` here, not only on the track: the hover fill it animates is the
			 * thumb's.
			 */}
			<ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-muted-foreground/30 transition-colors hover:bg-muted-foreground/50" />
		</ScrollAreaPrimitive.ScrollAreaScrollbar>
	);
}

export { ScrollArea, ScrollBar };
