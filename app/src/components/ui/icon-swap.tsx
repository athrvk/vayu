/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface IconSwapProps<S extends string> {
	/**
	 * The live icon, one of `icons`' keys. `NoInfer` so `icons` alone fixes `S`: inferring from
	 * both lets `state="copy"` narrow `S` to one key and reject the rest of the map.
	 */
	state: NoInfer<S>;
	/**
	 * Every icon, keyed by state (`{ copy: <Copy .../>, copied: <Check .../> }`). All render, so
	 * the largest sizes the box and a swap never moves the row, even between two 14px glyphs (a
	 * lucide icon's ink is not its box, and a `mr-1.5` on one shifts a label). A map, not inferred
	 * from `state` over time, for `LabelSwap`'s reason: a remembered set starts too narrow and
	 * jumps when a wider member first appears.
	 */
	icons: Readonly<Record<S, ReactNode>>;
	className?: string;
}

/**
 * An icon that fades to its replacement instead of popping (Copy → Check, Eye → EyeOff, Play →
 * Square, Folder → FolderOpen; #1686). `LabelSwap`'s mechanism with glyphs: every candidate in one
 * grid cell, the reserve twins `invisible` and `h-0`, and `key={state}` remounting the live one so
 * `.enter-fade` (`index.css`) reruns, as `@starting-style` fires only on an element's first frame.
 * Entry only: React removes the outgoing node synchronously, and JS motion is ruled out
 * (`docs/design-system/motion.md`). Not a variant of `data-icon-motion` (`icon-motion.ts`): a
 * motion animates one glyph on its owner's hover, a swap crossfades two on state. An icon can carry
 * both, so `IconSwap` adds nothing to the caller's element. Every twin is `aria-hidden`, the one
 * equal to the live state included, so a screen reader never meets an alternative glyph; the live
 * node keeps the caller's `aria-hidden`, as the button is named by `aria-label` either way.
 */
export function IconSwap<S extends string>({ state, icons, className }: IconSwapProps<S>) {
	const states = Object.keys(icons) as S[];
	return (
		<span className={cn("grid shrink-0 place-items-center", className)}>
			{states.map((candidate) => (
				<span
					key={candidate}
					aria-hidden="true"
					className="invisible col-start-1 row-start-1 h-0"
				>
					{icons[candidate]}
				</span>
			))}
			<span
				key={state}
				className="enter-fade col-start-1 row-start-1 grid place-items-center"
			>
				{icons[state]}
			</span>
		</span>
	);
}
