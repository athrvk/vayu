/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
	"inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
	{
		variants: {
			variant: {
				default:
					"border-transparent bg-primary-fill text-primary-foreground shadow hover:bg-primary-fill/80",
				secondary:
					"border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
				destructive:
					"border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
				outline: "text-foreground",
				/**
				 * Not interactive; the caller owns the colour - status-code
				 * chips, scope counts. No background, no text colour, and
				 * crucially no `hover:`.
				 *
				 * Every variant above pairs `bg-x` with `hover:bg-x/80`, and
				 * `cn()` is tailwind-merge, which treats `hover:bg-*` as a
				 * different group from `bg-*`. So a caller passing
				 * `className="bg-status-success-fill"` replaced the background
				 * and left the hover behind: a green 200 chip faded to the
				 * user's accent on hover, animated by the base
				 * `transition-colors`. None of these are clickable, so the
				 * hover was never wanted.
				 */
				chip: "border-transparent",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	}
);

export interface BadgeProps
	extends React.ComponentProps<"div">, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
	return (
		<div data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
	);
}

export { Badge, badgeVariants };
