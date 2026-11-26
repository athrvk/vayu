/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { cn } from "@/lib/utils";

interface LabelSwapProps {
	/** The text to show right now, e.g. `isExecuting ? "Sending" : "Send"`. */
	label: string;
	/**
	 * Every value `label` takes (`["Send", "Sending"]`), sizing the box to the widest so a swap
	 * only fades the text. Given explicitly, not remembered from `label`: a remembered set starts
	 * too narrow and resizes when a wider state first appears, the jump this prevents. A label that
	 * cannot be enumerated up front (a count, a status from data) has no widest to reserve: wrong
	 * fit.
	 */
	states: readonly string[];
	className?: string;
}

/**
 * A label that fades to its new text instead of popping and never resizes its control (Send →
 * Sending → Send). `TabLabel`'s trick (`tabs.tsx`): every candidate in one grid cell, invisible and
 * `h-0`, so the widest sizes the column and only the live text adds height. `TabLabel` takes one
 * string (a tab's bold-or-not); this takes the set, as a button's states are unrelated words.
 * `key={label}` remounts the live span so `.enter-fade` (`index.css`) reruns, as `@starting-style`
 * fires only on an element's first frame. Entry only: React removes the old node synchronously, and
 * JS motion is ruled out; a toggle faster than one fade restarts it, a quick flicker, accepted to
 * stay JS-free. `label` is always in `states`, so `key={label}` and a twin's `key={state}` match,
 * but React keys a mapped array apart from its siblings: no collision, no warning, and the live
 * span remounts both ways. (Tested when a reported Send → Sending fade but not back was blamed on
 * it; the asymmetry lies outside, likely a heavy render in the same commit starving
 * `@starting-style`'s paint.)
 */
export function LabelSwap({ label, states, className }: LabelSwapProps) {
	return (
		/*
		 * `data-slot` on both halves, as `tabs.tsx` marks `TabLabel`'s twin: the twins repeat the
		 * live strings, so `getByText` cannot tell them apart and a test of "the label says X"
		 * needs a handle.
		 */
		<span data-slot="label-swap" className={cn("grid", className)}>
			{states.map((state) => (
				<span
					key={state}
					data-slot="label-swap-reserve"
					aria-hidden="true"
					className="invisible col-start-1 row-start-1 h-0"
				>
					{state}
				</span>
			))}
			<span
				key={label}
				data-slot="label-swap-live"
				className="enter-fade col-start-1 row-start-1"
			>
				{label}
			</span>
		</span>
	);
}
