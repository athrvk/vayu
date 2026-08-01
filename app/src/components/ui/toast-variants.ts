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

import { cva } from "class-variance-authority";

/**
 * Lives beside `toast.tsx` rather than in it: a module that exports both a
 * component and a value cannot be hot-reloaded (`react-refresh/only-export-components`).
 */
export const toastVariants = cva(
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
