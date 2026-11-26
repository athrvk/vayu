/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { cva } from "class-variance-authority";

/**
 * Beside `badge.tsx`, not in it: a module exporting a component and a value cannot hot-reload
 * (`react-refresh/only-export-components`).
 */
export const badgeVariants = cva(
	"inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
	{
		variants: {
			variant: {
				default:
					"border-transparent bg-primary-fill text-primary-foreground shadow hover:bg-primary-fill-hover",
				secondary:
					"border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
				destructive:
					"border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
				outline: "text-foreground",
				/**
				 * Not interactive; the caller owns the colour (status-code chips, scope counts). No
				 * background, no text colour, and no `hover:`: the variants above pair `bg-x` with
				 * `hover:bg-x/80`, and `cn()`'s tailwind-merge treats `hover:bg-*` apart from
				 * `bg-*`, so a caller's `bg-status-success-fill` kept the hover and a green 200
				 * chip faded to the accent. None of these are clickable.
				 */
				chip: "border-transparent",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	}
);
