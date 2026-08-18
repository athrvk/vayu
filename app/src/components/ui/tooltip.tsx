/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
	className,
	sideOffset = 4,
	...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				data-slot="tooltip-content"
				sideOffset={sideOffset}
				className={cn(
					"z-50 overflow-hidden rounded-md bg-primary-fill px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-tooltip-content-transform-origin]",
					className
				)}
				{...props}
			/>
		</TooltipPrimitive.Portal>
	);
}

/**
 * Secondary text inside a tooltip - a shortcut, a URL, the source of a value.
 *
 * **`--muted-foreground` is not a de-emphasis here, it is a disappearance.** A
 * tooltip is `bg-primary-fill`, and that token is tuned against the canvas: on
 * the accent fills it measures 1.04-2.27:1, worst on Blue, where the hint is
 * often a URL the reader is meant to read off the tooltip. De-emphasis on a
 * *filled* surface has to be an alpha of the foreground that already reads on
 * it - the same argument `surface-sunken` makes for its `--rule` - which is
 * what this is, so the one value lives here rather than at each call site.
 * → `tooltip-hint-contrast.test.ts`
 */
function TooltipHint({ className, ...props }: React.ComponentProps<"span">) {
	return <span className={cn("text-primary-foreground/80", className)} {...props} />;
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipHint, TooltipProvider };
