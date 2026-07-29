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
 * One token family for all four variants, but not one tier. Per the design
 * system the three status tokens are not interchangeable: `--status-*` for a
 * rule, `--status-*-text` where the colour *is* the text, `--status-*-fill` only
 * under a white label. So the rail takes the bare `--status-*` and the glyph -
 * painted with a `text-` utility - takes `--status-*-text`. `border-destructive`
 * is gone.
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
				/*
				 * z-[100] against the dialogs' z-50, but the number is not what
				 * settles it: a dialog portals to `document.body` while this
				 * viewport lives inside `#root`, so they are sibling subtrees and a
				 * stacking context on any ancestor would scope this z-index inside
				 * it and let DOM order win instead. It matters because
				 * `SaveRunToRequestDialog` reports its failure while still open -
				 * the one path where losing would make a failure invisible.
				 *
				 * So it was hit-tested rather than reasoned about:
				 * `elementFromPoint` at the toast's centre, with an overlay and
				 * panel mounted at z-50, returns the toast's own content.
				 *
				 * The edge offset clears app chrome rather than being a round
				 * number. `fixed` anchors to the window, not to the layout, so a
				 * plain `bottom-4` put the stack 16px off the window floor - inside
				 * the Dock's 32px band, covering its lower half including
				 * "Connected" and the version string. Measured: viewport bottom at
				 * 704px against a Dock top of 688px. The same trap waits at the top
				 * edge, where the tab strip lives.
				 */
				"fixed z-[100] flex max-h-screen w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none",
				/*
				 * The edge offsets are no longer here: the stack is user-positioned
				 * (Settings -> Notifications), so which corner it anchors to and
				 * which chrome it has to clear both come from
				 * `TOAST_POSITIONS[].className` in constants/toast.ts. Every entry
				 * there still goes through --dock-height or --titlebar-height for
				 * the same reason the single hardcoded corner did.
				 */
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
		// duration-200 is pinned rather than left to the default because the store
		// holds a dismissed toast for exactly TIMING.TOAST_EXIT_MS before dropping
		// it. The two have to agree: shorter here and the node lingers after the
		// animation, longer and it is cut off mid-flight.
		"transition-all duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out",
		"data-[state=open]:slide-in-from-bottom-2 data-[state=open]:fade-in-0",
		"data-[state=closed]:slide-out-to-right-full data-[state=closed]:fade-out-80",
		// Swipe follows the pointer, then animates out past the threshold.
		"data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none",
		"data-[swipe=cancel]:translate-x-0",
		"data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=end]:animate-out",
	],
	{
		variants: {
			/*
			 * The rail reinforces; the **icon** is what actually carries the
			 * variant. Measured against the popover surface in both themes:
			 *
			 *            rail light / dark      icon light / dark
			 *   info       1.30 / 1.00           5.61 / 6.77
			 *   success    2.30 / 7.53           5.71 / 8.81
			 *   warning    4.00 / 4.34           5.46 / 9.81
			 *   error      3.78 / 4.59           5.88 / 5.85
			 *
			 * Two things follow. `info` is the neutral variant and takes no accent
			 * rail on purpose - `border-l-border` is invisible against the toast's
			 * own fill, which is the intent, and its icon still reads at 5.6+.
			 * And success's rail on white is only 2.30, under the 3:1 a graphic
			 * would need if it were the *sole* signal - which is precisely why the
			 * signal is not carried by colour alone. Every icon clears 5.4 in both
			 * themes.
			 *
			 * For scale, the border this replaces (`border-destructive/40`, the
			 * only variant marker there was) measured 1.16 in dark and 2.01 in
			 * light, against success's 2.21 / 1.42 - so the two were not reliably
			 * tellable apart in either theme, and error was near-invisible in dark.
			 */
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
