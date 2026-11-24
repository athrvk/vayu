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
					"motion-tooltip z-50 overflow-hidden rounded-md bg-primary-fill px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-tooltip-content-transform-origin]",
					className
				)}
				{...props}
			/>
		</TooltipPrimitive.Portal>
	);
}

/**
 * Secondary text in a tooltip (a shortcut, a URL, a value's source). **`--muted-foreground` here is
 * a disappearance**: the tooltip is `bg-primary-fill`, tuned against the canvas, and on the accent
 * fills it measures 1.04-2.27:1, worst on Blue, where the hint is often a URL to read. De-emphasis
 * on a *filled* surface is an alpha of the foreground that reads on it (as `surface-sunken` argues
 * for its `--rule`), so the one value lives here. → `tooltip-hint-contrast.test.ts`
 */
function TooltipHint({ className, ...props }: React.ComponentProps<"span">) {
	return <span className={cn("text-primary-foreground/80", className)} {...props} />;
}

/**
 * A shortcut tooltip's first line: the label, then the chord in a `TooltipHint`. Every shortcut
 * tooltip uses it, so the chord sits in the one tinted primitive at the one gap. Not parenthesised:
 * a "(Ctrl+K)" in the label string would sit outside `TooltipHint`, in plain foreground, its
 * spacing a template away from drifting. → `tooltip-shortcut-format.test.tsx`
 */
function TooltipShortcutLabel({ label, shortcut }: { label: string; shortcut: React.ReactNode }) {
	return (
		<span className="flex items-center gap-1.5">
			<span>{label}</span>
			<TooltipHint>{shortcut}</TooltipHint>
		</span>
	);
}

/**
 * A tooltip's value line with the hint saying where it came from, **never in one flex row**
 * (#1195): `TooltipContent` caps at `max-w-xs`, a value wraps on `break-all` (min-content about a
 * character), and a hint keeps its intrinsic width, so a row hands its width to the hint and leaves
 * the value a strip of letter fragments, as a long environment name beside an unbroken value did.
 * Stacked, the value gets the full width whichever is long, costing a short hint a line. A
 * truncated hint beside a `min-w-0 flex-1` value was rejected: a clipped source name loses "which
 * environment", half of what the reader hovered for.
 */
function TooltipValue({
	hint,
	className,
	children,
}: {
	/** Where the value came from - an environment, a bound row, a contract. */
	hint?: React.ReactNode;
	/** Classes for the value itself: its typeface, or the muted italic states. */
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<span className="flex flex-col gap-0.5">
			<span className={cn("break-all", className)}>{children}</span>
			{hint ? <TooltipHint>{hint}</TooltipHint> : null}
		</span>
	);
}

export {
	Tooltip,
	TooltipTrigger,
	TooltipContent,
	TooltipHint,
	TooltipShortcutLabel,
	TooltipValue,
	TooltipProvider,
};
