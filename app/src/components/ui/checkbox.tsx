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
 * A styled checkbox (`appearance-none`), not the bare native control, on which the radius and
 * `border-input` classes are inert: unnoticed at `size-icon` (16px), the defect showed as a flat
 * square once `KeyValueRow`'s row-enable checkbox grew to `size-target` (#1679). The checkmark is a
 * lucide `Check` shown via `peer-checked:opacity-100` on a sibling, sized as a percentage, since
 * the box is not one size (`size-icon`, `size-icon-sm`, `size-target`). The checked colour is the
 * caller's via `className`: `checked:bg-primary-fill checked:border-primary-fill` by default (the
 * fill token, as a white mark sits on it), overridable (the variables table's per-scope accent) as
 * `cn()` resolves the conflict.
 */
export type CheckboxProps = Omit<React.ComponentProps<"input">, "type" | "size">;

export function Checkbox({ className, ...props }: CheckboxProps) {
	return (
		// `w-fit h-fit`, not just `inline-flex`: a grid's `justify-items: stretch`
		// (`HeadersPanel`'s default-header row) widened the box the mark's percentage resolves
		// against, sizing the mark for the column.
		<span className="relative inline-flex w-fit h-fit shrink-0">
			<input
				type="checkbox"
				className={cn(
					// `min(var(--radius-md),25%)`, not `rounded-md`: `--radius-md` is 10px at
					// Rounded, past half a 12-16px box, which made a small checkbox a circle (a
					// radio button) while a 24-28px one stayed a rounded square. The cap only
					// removes roundness from a small box, and Square (`--radius: 0`) is unaffected.
					"peer inline-flex shrink-0 cursor-pointer appearance-none rounded-[min(var(--radius-md),25%)] border border-input bg-background transition-colors",
					"checked:border-primary-fill checked:bg-primary-fill",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
					"disabled:cursor-not-allowed disabled:opacity-50",
					className
				)}
				{...props}
			/>
			<Check
				aria-hidden="true"
				// A percentage, not `size-icon`: a fixed 16px mark filled a `size-icon` box and
				// overflowed a `size-icon-sm` one; scaling keeps a margin at every size.
				className="pointer-events-none absolute inset-0 m-auto size-[65%] text-primary-foreground opacity-0 peer-checked:opacity-100"
			/>
		</span>
	);
}
