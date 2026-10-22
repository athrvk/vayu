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

/**
 * A tooltip's first line when the control has a keyboard shortcut: the label,
 * then the chord in a `TooltipHint`.
 *
 * Every shortcut tooltip in the app renders through this, so the chord sits in
 * the one tinted primitive at the one gap whichever control it belongs to. The
 * chord is not parenthesised: a "(Ctrl+K)" written into the label string would
 * live outside `TooltipHint`, in the plain foreground, and the spacing would be
 * a string template away from drifting per call site.
 * → `tooltip-shortcut-format.test.tsx`
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
 * A tooltip's value line, with the hint that says where the value came from.
 *
 * **The two never share a flex row** (issue #1195). `TooltipContent` is capped
 * at `max-w-xs`, a value wraps on `break-all` - a min-content width of about
 * one character - and a hint has to keep its intrinsic width to stay readable,
 * so a row of the two hands its whole width to the hint and leaves the value a
 * vertical strip of letter fragments. That is not a rare shape: it needs only a
 * long environment name beside an unbroken value, and it hid the URL-ish values
 * these tooltips exist to show. Stacking them gives the value the full width
 * whichever of the two is long, and costs a hint that is short today nothing
 * but a line.
 *
 * The single-line alternative - `min-w-0 flex-1` on the value plus a truncated
 * hint - was rejected: a clipped source name loses the answer to "which
 * environment", which is half of what the reader hovered for.
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
