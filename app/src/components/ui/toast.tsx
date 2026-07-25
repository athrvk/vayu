/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Toast primitive
 *
 * The shadcn/Radix toast, wearing Vayu tokens. The store in
 * `stores/toast-store.ts` decides *what* is shown; this file and the primitive
 * underneath it own *when* and *how* - the dismiss timer, pausing on hover,
 * focus and window blur, swipe-to-dismiss, and the `data-state` the exit
 * animation keys off.
 *
 * Variant colour lives here rather than at the call site, and it is carried by
 * an icon plus a left rail, never by colour alone. The hand-rolled version this
 * replaces signalled variant with a 40%-alpha border and nothing else, which in
 * dark mode made an error and an info toast near-indistinguishable:
 * `--destructive` is `0 62.8% 30.6%` there, and at 40% over `--popover`
 * (`240 6% 11%`) there is almost nothing left to see.
 *
 * One token family for all four variants. Per the design system the three
 * status tokens are not interchangeable: `--status-*` for an icon or rule,
 * `--status-*-text` where the colour *is* the text, `--status-*-fill` only
 * under a white label. These are icons and rails, so they take the bare
 * `--status-*`, and `border-destructive` is gone.
 *
 * The outer edge stays `border-border`. That edge faces the canvas, which is
 * the case the design system calls correct for `border-border`; it is
 * deliberately not `border-rule`, because no `surface-popover` class is
 * declared and `border-rule` under no declared surface silently falls back to
 * the invisible default.
 */

import * as React from "react";
import * as ToastPrimitives from "@radix-ui/react-toast";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";

const ToastProvider = ToastPrimitives.Provider;

function ToastViewport({
	className,
	...props
}: React.ComponentProps<typeof ToastPrimitives.Viewport>) {
	return (
		<ToastPrimitives.Viewport
			data-slot="toast-viewport"
			className={cn(
				// z-[100] clears the dialogs at z-50: SaveRunToRequestDialog
				// reports its failure while still open, so the toast has to sit
				// over the overlay rather than under it.
				"fixed bottom-4 right-4 z-[100] flex max-h-screen w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none",
				className
			)}
			{...props}
		/>
	);
}

const toastVariants = cva(
	[
		"group pointer-events-auto relative flex w-full items-start gap-2.5 overflow-hidden",
		"rounded-md border border-l-2 border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-lg",
		// Enter from below (the stack lives bottom-right), leave to the right so
		// the exit reads as the same gesture a swipe would make. `prefers-reduced-
		// motion` is already collapsed globally in index.css, so there is nothing
		// to add here.
		"transition-all data-[state=open]:animate-in data-[state=closed]:animate-out",
		"data-[state=open]:slide-in-from-bottom-2 data-[state=open]:fade-in-0",
		"data-[state=closed]:slide-out-to-right-full data-[state=closed]:fade-out-80",
		// Swipe follows the pointer, then animates out past the threshold.
		"data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none",
		"data-[swipe=cancel]:translate-x-0",
		"data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=end]:animate-out",
	],
	{
		variants: {
			variant: {
				info: "border-l-border",
				success: "border-l-status-success",
				warning: "border-l-status-warning",
				error: "border-l-status-error",
			},
		},
		defaultVariants: { variant: "info" },
	}
);

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
			 * "background", always, including errors - Radix's word for polite.
			 *
			 * Inherited unchanged from the component this replaces, where it was
			 * argued out: a toast dismisses itself on a timer, and every toast in
			 * this app reports the outcome of something the user just did, so
			 * they are already waiting for the answer. Interrupting whatever they
			 * are reading is the wrong trade. "foreground" would make it
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
 * `-text`, not the bare `--status-*`, because these are painted with a `text-`
 * utility onto the popover surface. The rail above is a rule and correctly takes
 * the bare token; a glyph is foreground and takes the tier tuned to be read
 * against a background. Enforced repo-wide by `status-color-tokens.test.ts`.
 */
const VARIANT_ICON_CLASS: Record<ToastVariantName, string> = {
	info: "text-muted-foreground",
	success: "text-status-success-text",
	warning: "text-status-warning-text",
	error: "text-status-error-text",
};

/**
 * The redundant half of the signal. Colour alone fails anyone who cannot
 * separate the hues, and it failed everyone in dark mode; the glyph carries the
 * meaning on its own.
 */
function ToastIcon({ variant }: { variant: ToastVariantName }) {
	const Icon = VARIANT_ICON[variant];
	return (
		<Icon
			aria-hidden="true"
			className={cn("mt-px h-4 w-4 shrink-0", VARIANT_ICON_CLASS[variant])}
		/>
	);
}

function ToastTitle({ className, ...props }: React.ComponentProps<typeof ToastPrimitives.Title>) {
	return (
		<ToastPrimitives.Title
			data-slot="toast-title"
			className={cn("text-sm font-medium leading-snug", className)}
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
			className={cn("text-sm leading-snug", className)}
			{...props}
		/>
	);
}

function ToastAction({ className, ...props }: React.ComponentProps<typeof ToastPrimitives.Action>) {
	return (
		<ToastPrimitives.Action
			data-slot="toast-action"
			className={cn(
				"mt-1.5 inline-flex h-7 shrink-0 items-center rounded-md border border-border px-2.5",
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
			// The icon is 14px; the padding is what makes it clickable. The old
			// button had neither padding nor a focus ring, so it was a 14px
			// target that gave no sign of being focused.
			className={cn(
				"shrink-0 rounded-md p-1 text-muted-foreground transition-colors",
				"hover:bg-muted hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-popover",
				className
			)}
			{...props}
		>
			<X className="h-3.5 w-3.5" />
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
	toastVariants,
};
