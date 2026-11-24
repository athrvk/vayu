/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { cva } from "class-variance-authority";

/**
 * Beside `button.tsx`, not in it: a module exporting a component and a value cannot hot-reload
 * (`react-refresh/only-export-components`).
 */
export const buttonVariants = cva(
	// No `transition-colors`: a `@layer utilities` class beats the `@layer base` transition in
	// index.css that already covers this element (`button, [role="button"], a[href], summary`,
	// `scale` included), replacing that whole list.
	//
	// `[&_svg:not([class*='size-'])]:size-icon`, not `[&_svg]:size-icon` (#1679): a class plus type
	// descendant rule is `(0,1,1)` and outranks a `size-icon-sm` on the icon (`(0,1,0)`), so
	// callers wanting the smaller glyph got 16px. The `:not` makes the default not match once a
	// caller sizes the icon, so there is no contest.
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-icon [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default:
					"bg-primary-fill text-primary-foreground shadow hover:bg-primary-fill-hover",
				destructive:
					"bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
				outline:
					"border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
				secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
				ghost: "hover:bg-accent hover:text-accent-foreground",
				link: "text-primary underline-offset-4 hover:underline",
				/*
				 * Row actions: controls on a row already hovered (⋯, delete, copy). Not `ghost`,
				 * which hovers to bg-accent, what the row already paints, so it shows no hover;
				 * these step to accent-active.
				 */
				rowAction: "text-muted-foreground hover:bg-accent-active hover:text-foreground",
				/*
				 * Like rowAction, but the glyph turns red on hover. No red background: the row has
				 * one fill, a second tint is noise, and the delete confirmation is the protection.
				 * `destructive-text`, not `destructive`: against `--accent-active` the fill token
				 * gives 3.66 light / 1.27 dark (under the 3.0 glyph floor), `destructive-text` 4.12
				 * / 3.96. Those miss the 4.5 text needs, so this is icon-only (every call site is a
				 * Trash2 at size="icon"); a labelled button needs another variant.
				 */
				rowActionDestructive:
					"text-muted-foreground hover:bg-accent-active hover:text-destructive-text",
				/*
				 * A full-width, left-aligned clickable row (a summary row, a "recent items" entry),
				 * which `default`'s fixed-height, centred shape cannot give. Not named `row`: "Row
				 * Actions" above owns that word for the small hover controls. Only the axis-level
				 * shape lives here (`justify-start`, `text-left`); padding, gap, text and icon size
				 * stay with the caller, as the call sites span three scales. `h-auto` and
				 * `active:scale-100` are in `compoundVariants`: cva puts `size`'s classes after
				 * `variant`'s, so a height here loses to `size`'s `h-control` in `cn()`, and the
				 * base's `active:scale` would beat a `scale-100` here.
				 */
				listRow: "w-full justify-start text-left",
			},
			// `default`/`sm`/`icon` read the control/target floors (#1679), not the `--spacing`
			// rhythm: `h-9` and `h-8` were 27px/24px under the 3px unit, and `icon` at `h-9 w-9` a
			// 27px target, under WCAG 2.2 SC 2.5.8's 24x24px floor.
			size: {
				default: "h-control px-4 py-2",
				sm: "h-control-sm px-3 text-xs",
				icon: "size-target",
			},
		},
		compoundVariants: [
			{
				variant: "listRow",
				// `active:scale-100`: the press shrink (`index.css`'s
				// `[data-slot="button"]:active`) is 2% of the element's box, fine on a compact CTA
				// and a glitch on a full-width row (the distinction index.css's comment draws for
				// `a[href]` / `[role="button"]`). A 1290px row (`SampledExchange`, inside its own
				// 1px border) shrinks 13px a side, detaching from the border.
				class: "h-auto active:scale-100",
			},
		],
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	}
);
