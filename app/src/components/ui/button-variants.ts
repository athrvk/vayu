/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { cva } from "class-variance-authority";

/**
 * Lives beside `button.tsx` rather than in it: a module that exports both a
 * component and a value cannot be hot-reloaded (`react-refresh/only-export-components`).
 */
export const buttonVariants = cva(
	// No `transition-colors` here: it is a `@layer utilities` class, which
	// beats the `@layer base` baseline transition in index.css that already
	// covers this element (`button, [role="button"], a[href], summary`,
	// including `scale` for press feedback) - a utility here would win the
	// cascade and replace that whole list.
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-primary-fill text-primary-foreground shadow hover:bg-primary-fill/90",
				destructive:
					"bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
				outline:
					"border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
				secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
				ghost: "hover:bg-accent hover:text-accent-foreground",
				link: "text-primary underline-offset-4 hover:underline",
				/*
				 * Row actions - the controls that appear on a row you are already
				 * hovering (⋯, delete, copy). `ghost` is wrong for these: it hovers
				 * to bg-accent, which is exactly what the row underneath already
				 * paints, so the button appears to have no hover state at all.
				 * These step up to accent-active instead.
				 */
				rowAction: "text-muted-foreground hover:bg-accent-active hover:text-foreground",
				/*
				 * Same shape as rowAction - only the glyph turns red, and only on
				 * hover. No red background: the row already carries one fill, a
				 * second competing tint is noise, and the delete confirmation is
				 * what actually protects the user.
				 *
				 * `destructive-text`, not `destructive`. Measured against
				 * `--accent-active`, the fill token gives 3.66 light / 1.27 dark -
				 * the dark figure missing even the 3.0 floor for a glyph.
				 * `destructive-text` gives 4.12 / 3.96.
				 *
				 * Those clear 3.0 but not the 4.5 that *text* would need, and this
				 * variant is icon-only by design (all three call sites render a
				 * Trash2 at size="icon"). Put a text label in it and it stops
				 * passing - use a different variant.
				 */
				rowActionDestructive:
					"text-muted-foreground hover:bg-accent-active hover:text-destructive-text",
				/*
				 * A full-width, left-aligned clickable row - the shape a summary row
				 * or a "recent items" entry needs, and `default`'s fixed-height,
				 * content-fit, centered shape cannot give. Deliberately not named
				 * `row` - the "Row Actions" section above already owns that word for
				 * the small hover-revealed `⋯`/delete controls on a row, a different
				 * thing at a different scale.
				 *
				 * Only the axis-level shape lives here: `justify-center` flips to
				 * `justify-start`, `text-left` beats the base's implicit centering.
				 * Padding, gap, text size and icon size stay with the caller's own
				 * `className` - the call sites this converts span three different
				 * padding/text scales (a context-bar row is not a welcome-screen
				 * row), and a single opinion here would renormalize all of them.
				 * `h-auto` lives in `compoundVariants` below, not here: cva
				 * concatenates `size`'s classes after `variant`'s, so a height set
				 * in this string loses to `size`'s default `h-9` once both pass
				 * through the same `cn()` merge.
				 */
				listRow: "w-full justify-start text-left",
			},
			size: {
				default: "h-9 px-4 py-2",
				sm: "h-8 px-3 text-xs",
				lg: "h-10 px-8",
				icon: "h-9 w-9",
			},
		},
		compoundVariants: [{ variant: "listRow", class: "h-auto" }],
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	}
);
