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
	 * Every value `label` can take, e.g. `["Send", "Sending"]`. Sizes the box to
	 * the widest one so a swap never resizes its container - only the text
	 * fades. This has to be given explicitly rather than inferred from `label`
	 * over time: a set built by remembering past values would start too narrow
	 * on first render and still resize once a wider state is seen for the first
	 * time, which is the exact jump this component exists to prevent. If the
	 * caller can't enumerate every value up front (a count, a status string
	 * from data), this component is the wrong fit - a data-derived label has no
	 * fixed "widest" to reserve.
	 */
	states: readonly string[];
	className?: string;
}

/**
 * A label that fades to its new text instead of popping, and never resizes
 * the control around it - the Send → Sending → Send case.
 *
 * Same trick as `TabLabel` (`tabs.tsx`): every candidate string sits in the
 * same grid cell, invisible and `h-0`, so the column is sized by the widest
 * one while only the live text contributes height. `TabLabel` takes a single
 * string because a tab has one bold-vs-not distinction; this takes the whole
 * enumerable set because a button's states are typically unrelated words
 * ("Send"/"Sending"), not one word in two weights.
 *
 * `key={label}` on the live span remounts it on every change, which is what
 * makes `.enter-fade` (`index.css`) run again - `@starting-style` only fires
 * for an element's first frame, so without the remount a `label` update would
 * just repaint the same node with no transition. Entry only, by the same
 * limitation `.enter-fade` documents everywhere else: React removes the old
 * text node synchronously, so there is no fade-out half without JS-driven
 * motion, which this design system rules out. A fast toggle (Send → Sending
 * → Send within one `.enter-fade` duration) does not crossfade - the
 * in-flight node is torn down and the next one starts its own fade from
 * scratch, which reads as a quick flicker rather than a smooth crossfade.
 * That is an accepted trade for staying JS-free, not an oversight.
 *
 * `label` is always a member of `states` (that is what makes the width
 * reservation correct), so a bare `key={label}` and a bare `key={state}`
 * do collide on whichever twin equals the current label. This was suspected
 * as the cause of a real, reported directional bug (Send → Sending fades,
 * Sending → Send does not) - but tested directly and ruled out: React scopes
 * a mapped array as its own keyspace, separate from a sibling's, so there is
 * no reconciler collision here and no console warning either. The live span
 * remounts correctly both directions. The actual asymmetry lives elsewhere -
 * most likely a heavy render landing in the same commit as the label change
 * on one direction and not the other, which can starve the browser of the
 * paint `@starting-style` needs - not in this component.
 */
export function LabelSwap({ label, states, className }: LabelSwapProps) {
	return (
		<span className={cn("grid", className)}>
			{states.map((state) => (
				<span
					key={state}
					aria-hidden="true"
					className="invisible col-start-1 row-start-1 h-0"
				>
					{state}
				</span>
			))}
			<span key={label} className="enter-fade col-start-1 row-start-1">
				{label}
			</span>
		</span>
	);
}
