/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A styled checkbox - `appearance-none`, not the bare native control.
 *
 * The radius and `border-input` classes below are inert on an unstyled native
 * checkbox (no visual effect without `appearance-none`), and so was
 * `accent-color`'s companion `focus:ring-*` (no `ring` width class ever
 * paired with it) - both `KeyValueRow`'s row-enable checkbox and the
 * variables table's `accent-scope-*` one carried these as dead classes. It
 * went unnoticed at `size-icon` (16px), where a browser's own native corner
 * rounding reads as "a small checkbox" regardless; it turned into a stark,
 * barely-rounded flat square once `KeyValueRow`'s grew to the `size-target`
 * floor (issue #1679) for its own WCAG 2.5.8 hit area - the defect was
 * always there, just invisible below that size.
 *
 * The checkmark is a real lucide `Check`, shown via `peer-checked:opacity-100`
 * on a sibling rather than an inline SVG data URI baked into a class string.
 * It is sized as a percentage of the box rather than a fixed icon step, since
 * the box itself is not one size across callers (`size-icon`, `size-icon-sm`,
 * `size-target`).
 *
 * The checked-state color is the caller's via `className` -
 * `checked:bg-primary checked:border-primary` by default, overridable (e.g.
 * the variables table's per-scope accent) since `cn()` resolves the conflict.
 */
export type CheckboxProps = Omit<React.ComponentProps<"input">, "type" | "size">;

export function Checkbox({ className, ...props }: CheckboxProps) {
	return (
		// `w-fit h-fit`, not just `inline-flex`: a CSS grid's default
		// `justify-items: stretch` (`HeadersPanel`'s default-header row is one)
		// stretches an auto-width item to its column - here, that silently
		// widened the containing block the checkmark's percentage size below
		// resolves against, so the mark came out sized for the *column*, not
		// this box.
		<span className="relative inline-flex w-fit h-fit shrink-0">
			<input
				type="checkbox"
				className={cn(
					// `min(var(--radius-md),25%)`, not a bare `rounded-md`: the box
					// isn't one size across callers either, and a fixed radius reads
					// very differently against each - `--radius-md` is 10px at the
					// Rounded appearance setting, past half of a 12-16px box, so a
					// small checkbox became a literal circle (indistinguishable from a
					// radio button) while a 24-28px one stayed a normal rounded square.
					// The cap only ever removes roundness from a small box; it never
					// adds any to a large one, and Square (`--radius: 0`) is unaffected
					// at every size.
					"peer inline-flex shrink-0 cursor-pointer appearance-none rounded-[min(var(--radius-md),25%)] border border-input bg-background transition-colors",
					"checked:border-primary checked:bg-primary",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
					"disabled:cursor-not-allowed disabled:opacity-50",
					className
				)}
				{...props}
			/>
			<Check
				aria-hidden="true"
				// A percentage, not `size-icon`: the mark sits inside boxes of more
				// than one size (`size-icon`, `size-icon-sm`, `size-target`), and a
				// fixed 16px one filled a `size-icon` box edge to edge - and
				// overflowed a `size-icon-sm` one. Scaling with the box keeps a
				// margin at every size instead.
				className="pointer-events-none absolute inset-0 m-auto size-[65%] text-primary-foreground opacity-0 peer-checked:opacity-100"
			/>
		</span>
	);
}
