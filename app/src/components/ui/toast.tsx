/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The shadcn/Radix toast in Vayu tokens. `stores/toast-store.ts` decides *what* shows; this and the
 * primitive own *when* and *how*: the dismiss timer, pausing on hover, focus and window blur,
 * swipe-to-dismiss, and the `data-state` the exit animation keys off.
 *
 * Variant colour lives here, not at the call site, carried by an icon plus a left rail, never
 * colour alone: a 40%-alpha border alone made a dark error and info toast near-indistinguishable
 * (`--destructive` is `0 62.8% 30.6%` there, little left at 40% over `--popover`'s `240 6% 11%`).
 *
 * One token family, not one tier: `--status-*` for a rule, `--status-*-text` where the colour is
 * text, `--status-*-fill` only under a white label. So the rail takes `--status-*` and the glyph,
 * painted with `text-`, takes `--status-*-text`.
 *
 * The outer edge is `border-border`: it faces the canvas, the case the design system names for it.
 * Not `border-rule`, as no `surface-popover` is declared and `border-rule` would fall back to the
 * invisible default.
 */

import * as React from "react";
import * as ToastPrimitives from "@radix-ui/react-toast";
import { type VariantProps } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { toastVariants } from "./toast-variants";

const ToastProvider = ToastPrimitives.Provider;

function ToastViewport({
	className,
	...props
}: React.ComponentProps<typeof ToastPrimitives.Viewport>) {
	return (
		<ToastPrimitives.Viewport
			data-slot="toast-viewport"
			className={cn(
				/*
				 * z-[100] against the dialogs' z-50, but DOM structure settles it: a dialog portals
				 * to `document.body` while this viewport is inside `#root`, sibling subtrees, so a
				 * stacking context on an ancestor would scope this z-index and let DOM order win.
				 * It matters because `SaveRunToRequestDialog` reports its failure while open, where
				 * losing hides the failure. Hit-tested: `elementFromPoint` at the toast's centre,
				 * with an overlay and panel at z-50, returns the toast. `w-xs` (20rem, Tailwind's
				 * container scale), not `w-80`: a text measure, and `w-80` rides `--spacing` (240px
				 * at Default).
				 */
				"fixed z-[100] flex max-h-screen w-xs max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none",
				/*
				 * The edge offsets are the user's corner (Settings -> Notifications), from
				 * `TOAST_POSITIONS[].className` in constants/toast.ts. Each clears app chrome
				 * through `--dock-height` or `--titlebar-height`: `fixed` anchors to the window, so
				 * a bare `bottom-4` sat inside the Dock's 32px band, over "Connected" and the
				 * version.
				 */
				className
			)}
			{...props}
		/>
	);
}

export type ToastVariantName = NonNullable<VariantProps<typeof toastVariants>["variant"]>;

function Toast({
	className,
	variant,
	...props
}: React.ComponentProps<typeof ToastPrimitives.Root> & VariantProps<typeof toastVariants>) {
	return (
		<ToastPrimitives.Root
			data-slot="toast"
			/*
			 * "background", always, errors included (Radix's word for polite): a toast dismisses on
			 * a timer and reports the outcome of something the user just did, so they are waiting
			 * for it, and interrupting what they read is the wrong trade. "foreground" is
			 * assertive.
			 */
			type="background"
			className={cn(toastVariants({ variant }), className)}
			{...props}
		/>
	);
}

const VARIANT_ICON: Record<ToastVariantName, React.ComponentType<{ className?: string }>> = {
	info: Info,
	success: CheckCircle2,
	warning: AlertTriangle,
	error: XCircle,
};

/**
 * `-text`, not the bare `--status-*`: painted with `text-` on the popover, a glyph is foreground
 * and takes the tier tuned to be read; the rail is a rule and takes the bare token. Enforced by
 * `status-color-tokens.test.ts`.
 */
const VARIANT_ICON_CLASS: Record<ToastVariantName, string> = {
	info: "text-muted-foreground",
	success: "text-status-success-text",
	warning: "text-status-warning-text",
	error: "text-status-error-text",
};

/**
 * The redundant half of the signal: colour alone fails anyone who cannot separate hues, and failed
 * everyone in dark; the glyph carries the meaning alone.
 */
function ToastIcon({ variant }: { variant: ToastVariantName }) {
	const Icon = VARIANT_ICON[variant];
	return (
		<Icon
			aria-hidden="true"
			className={cn("mt-px size-icon shrink-0", VARIANT_ICON_CLASS[variant])}
		/>
	);
}

function ToastTitle({ className, ...props }: React.ComponentProps<typeof ToastPrimitives.Title>) {
	return (
		<ToastPrimitives.Title
			data-slot="toast-title"
			className={cn("text-sm font-medium leading-snug break-words", className)}
			{...props}
		/>
	);
}

function ToastDescription({
	className,
	...props
}: React.ComponentProps<typeof ToastPrimitives.Description>) {
	return (
		<ToastPrimitives.Description
			data-slot="toast-description"
			className={cn("text-sm leading-snug break-words", className)}
			{...props}
		/>
	);
}

function ToastAction({ className, ...props }: React.ComponentProps<typeof ToastPrimitives.Action>) {
	return (
		<ToastPrimitives.Action
			data-slot="toast-action"
			// `h-control-sm` (#1679, 24px): `h-7` was 21px, under WCAG 2.2 SC 2.5.8.
			className={cn(
				"mt-1.5 inline-flex h-control-sm shrink-0 items-center self-start rounded-md border border-border px-2.5",
				"text-xs font-medium transition-colors hover:bg-muted",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-popover",
				className
			)}
			{...props}
		/>
	);
}

function ToastClose({ className, ...props }: React.ComponentProps<typeof ToastPrimitives.Close>) {
	return (
		<ToastPrimitives.Close
			data-slot="toast-close"
			// `size-target` (#1679, 24px), not a padding-derived ~22px box; the icon shrinks to
			// `size-icon-sm` (12px) inside rather than growing the target.
			className={cn(
				"flex size-target shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
				"hover:bg-muted hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-popover",
				className
			)}
			{...props}
		>
			<X className="size-icon-sm" />
		</ToastPrimitives.Close>
	);
}

export {
	ToastProvider,
	ToastViewport,
	Toast,
	ToastIcon,
	ToastTitle,
	ToastDescription,
	ToastAction,
	ToastClose,
};
