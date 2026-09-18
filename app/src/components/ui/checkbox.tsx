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
 * `rounded-md`/`border-input` on an unstyled native checkbox are inert (no
 * visual effect without `appearance-none`), and so was `accent-color`'s
 * companion `focus:ring-*` (no `ring` width class ever paired with it) -
 * both `KeyValueRow`'s row-enable checkbox and the variables table's
 * `accent-scope-*` one carried these as dead classes. It went unnoticed at
 * `size-icon` (16px), where a browser's own native corner rounding reads as
 * "a small checkbox" regardless; it turned into a stark, barely-rounded flat
 * square once `KeyValueRow`'s grew to the `size-target` floor (issue #1679)
 * for its own WCAG 2.5.8 hit area - the defect was always there, just
 * invisible below that size.
 *
 * The checkmark is a real lucide `Check`, shown via `peer-checked:opacity-100`
 * on a sibling rather than an inline SVG data URI baked into a class string,
 * so it renders and sizes like every other icon in the app.
 *
 * The checked-state color is the caller's via `className` -
 * `checked:bg-primary checked:border-primary` by default, overridable (e.g.
 * the variables table's per-scope accent) since `cn()` resolves the conflict.
 */
export type CheckboxProps = Omit<React.ComponentProps<"input">, "type" | "size">;

export function Checkbox({ className, ...props }: CheckboxProps) {
	return (
		<span className="relative inline-flex shrink-0">
			<input
				type="checkbox"
				className={cn(
					"peer inline-flex shrink-0 cursor-pointer appearance-none rounded-md border-2 border-input bg-background transition-colors",
					"checked:border-primary checked:bg-primary",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
					"disabled:cursor-not-allowed disabled:opacity-50",
					className
				)}
				{...props}
			/>
			<Check
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 m-auto size-icon text-primary-foreground opacity-0 peer-checked:opacity-100"
			/>
		</span>
	);
}
