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
	 * How far through, 0 to 1 - or **null** when the total is not known.
	 *
	 * Null is not zero, and the two must not collapse into one another: a
	 * download whose upstream declared no `Content-Length` is somewhere in the
	 * middle of itself and simply cannot say where, while zero is a job that has
	 * not started. Radix drops `aria-valuenow` for null, which is right - a
	 * screen reader announcing "0 percent" of a half-finished download would be
	 * stating a fraction nobody measured.
	 */
	value: number | null;
	/**
	 * What is in progress, for assistive tech. Required: a bar is a number with
	 * no noun in it, and a screen reader announcing "62 percent" of nothing is
	 * not an accessible bar.
	 */
	label: string;
	className?: string;
}

/**
 * A determinate or indeterminate progress bar (issue #882).
 *
 * Radix owns the ARIA: the `progressbar` role, `aria-valuemin`/`max`, and
 * dropping `aria-valuenow` in the indeterminate state. Only `aria-busy` is added
 * here - Radix expresses that state as `data-state="indeterminate"`, which
 * styles a bar but tells a screen reader nothing.
 *
 * The track is `surface-sunken` because that is the app's one recessed fill that
 * reads on a card in both themes, and the fill is `bg-primary` per the accent
 * rule - `--primary-fill` is for solids that carry a white label, and this
 * carries none.
 *
 * Under reduced motion the indeterminate stripe stops moving, which is correct
 * and is why every caller of this state also shows a figure that keeps changing
 * (bytes received): the information is in the text, and the motion is only the
 * hint that something is still happening.
 */
export function Progress({ value, label, className }: ProgressProps) {
	const known = value !== null;
	// Clamped before it reaches Radix, which warns on a value outside 0..max: an
	// upstream that under-declares its `Content-Length` hands over more bytes
	// than it said it would.
	const percent = known ? Math.round(Math.min(1, Math.max(0, value)) * 100) : null;

	return (
		<ProgressPrimitive.Root
			value={percent}
			max={100}
			aria-label={label}
			{...(known ? {} : { "aria-busy": true })}
			// `rounded-full` rather than a radius token: a track is a pill at every
			// roundedness setting, which is the setting's documented exemption.
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
