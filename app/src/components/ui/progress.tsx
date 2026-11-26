/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import * as ProgressPrimitive from "@radix-ui/react-progress";

import { cn } from "@/lib/utils";

export interface ProgressProps {
	/**
	 * How far through, 0 to 1, or **null** when the total is unknown. Null is not zero: a download
	 * with no `Content-Length` is somewhere in the middle and cannot say where, while zero has not
	 * started. Radix drops `aria-valuenow` for null, rightly: "0 percent" of a half-finished
	 * download states a fraction nobody measured.
	 */
	value: number | null;
	/**
	 * What is in progress, for assistive tech; required, as "62 percent" of nothing is not an
	 * accessible bar.
	 */
	label: string;
	className?: string;
}

/**
 * A determinate or indeterminate progress bar (#882). Radix owns the ARIA (the role,
 * `aria-valuemin`/`max`, no `aria-valuenow` when indeterminate); only `aria-busy` is added, as
 * Radix's `data-state="indeterminate"` tells a screen reader nothing. The track is
 * `surface-sunken`, the one recessed fill reading on a card in both themes; the fill is
 * `bg-primary` per the accent rule (`--primary-fill` is for solids carrying a white label). Under
 * reduced motion the stripe stops, so every indeterminate caller also shows a changing figure
 * (bytes received): the information is in the text.
 */
export function Progress({ value, label, className }: ProgressProps) {
	const known = value !== null;
	// Clamped before Radix, which warns outside 0..max: an upstream under-declaring
	// `Content-Length` sends more bytes than it said.
	const percent = known ? Math.round(Math.min(1, Math.max(0, value)) * 100) : null;

	return (
		<ProgressPrimitive.Root
			value={percent}
			max={100}
			aria-label={label}
			{...(known ? {} : { "aria-busy": true })}
			// `rounded-full`, not a radius token: a track is a pill at every roundedness, the
			// setting's documented exemption.
			className={cn("h-1.5 w-full overflow-hidden rounded-full surface-sunken", className)}
		>
			<ProgressPrimitive.Indicator
				className={cn(
					"h-full rounded-full bg-primary",
					known
						? "transition-[width] duration-200 ease-out"
						: "progress-indeterminate w-1/3"
				)}
				{...(known ? { style: { width: `${percent}%` } } : {})}
			/>
		</ProgressPrimitive.Root>
	);
}
