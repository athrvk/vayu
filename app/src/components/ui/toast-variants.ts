/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The toast's variant classes, beside `toast.tsx` rather than in it: a module exporting a component
 * and a value cannot hot-reload (`react-refresh/only-export-components`). `toast.tsx`'s header has
 * the design: the variant carried by an icon plus a left rail, the rail on the bare `--status-*`
 * token, and the outer edge on `border-border`.
 */

import { cva } from "class-variance-authority";

export const toastVariants = cva(
	[
		"group pointer-events-auto relative flex w-full items-start gap-2.5 overflow-hidden",
		"rounded-md border border-l-2 border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-lg",
		// Enter from below (the stack is bottom-right), leave right, the gesture a swipe makes.
		// Reduced motion is collapsed globally in index.css. `duration-200` is pinned: the store
		// holds a dismissed toast exactly TIMING.TOAST_EXIT_MS, and shorter here leaves the node
		// lingering, longer cuts it mid-flight. It is also the enter/exit duration (tw-animate-css
		// reads this `--tw-duration`) and the swipe-cancel snap-back below, so change it only with
		// TIMING.TOAST_EXIT_MS. Decelerate in, accelerate out, as Dialog and anchored chrome (the
		// `:root` motion vocabulary in index.css): the curve only, the duration being pinned.
		"[--tw-ease:var(--ease-enter)] data-[state=closed]:[--tw-ease:var(--ease-exit)]",
		"duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out",
		"data-[state=open]:slide-in-from-bottom-2 data-[state=open]:fade-in-0",
		"data-[state=closed]:slide-out-to-right-full data-[state=closed]:fade-out-80",
		// Explicit paint properties, not `transition-all` (which can animate layout): `translate`
		// for the swipe-cancel snap-back, `opacity` free beside it.
		"transition-[translate,opacity] duration-200",
		// Swipe follows the pointer, then animates out past the threshold.
		"data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none",
		"data-[swipe=cancel]:translate-x-0",
		"data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=end]:animate-out",
	],
	{
		variants: {
			/*
			 * The rail reinforces; the **icon** carries the variant. Measured on the popover
			 * surface:
			 *
			 *            rail light / dark      icon light / dark
			 *   info       1.30 / 1.00           5.61 / 6.77
			 *   success    2.30 / 7.53           5.71 / 8.81
			 *   warning    4.00 / 4.34           5.46 / 9.81
			 *   error      3.78 / 4.59           5.88 / 5.85
			 *
			 * `info`, the neutral variant, takes no accent rail on purpose (`border-l-border`
			 * vanishes on the fill), its icon reading at 5.6+. Success's rail on white is 2.30,
			 * under the 3:1 a sole graphic signal needs, which is why colour is not the only
			 * signal; every icon clears 5.4 in both themes.
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
