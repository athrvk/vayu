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
	 * Which icon is live right now - one of `icons`' keys.
	 *
	 * `NoInfer` so `S` is fixed by the `icons` map alone: inferring from both
	 * would let a literal `state="copy"` narrow `S` to just that one key and
	 * then reject the rest of the map as excess properties.
	 */
	state: NoInfer<S>;
	/**
	 * Every icon this control can show, keyed by state: e.g.
	 * `{ copy: <Copy .../>, copied: <Check .../> }`. All of them render, so the
	 * box is sized by the largest and a swap never moves the row around it -
	 * which matters even between two 14px glyphs, because a lucide icon's ink
	 * is not its box and a `mr-1.5` on one of a pair is enough to shift a label.
	 *
	 * Given as a map rather than inferred from `state` over time for the reason
	 * `LabelSwap` documents: a set built by remembering what has been seen
	 * starts too narrow and still jumps the first time a wider member appears,
	 * which is the jump this component exists to prevent.
	 */
	icons: Readonly<Record<S, ReactNode>>;
	className?: string;
}

/**
 * An icon that fades to its replacement instead of popping - the Copy → Check,
 * Eye → EyeOff, Play → Square, Folder → FolderOpen case (#1686).
 *
 * The same mechanism as `LabelSwap` (`label-swap.tsx`), with glyphs instead of
 * words: every candidate sits in the same CSS grid cell, the reserve twins
 * `invisible` and `h-0` so only the live one contributes height, and
 * `key={state}` on the live one remounts it so `.enter-fade` (`index.css`)
 * runs again - `@starting-style` only fires for an element's first frame, so
 * without the remount a state change would repaint the same node with no
 * transition. Entry only, by that same limitation: React removes the outgoing
 * node synchronously, so there is no fade-out half without JS-driven motion,
 * which this design system rules out (see Motion in `docs/design-system.md`).
 *
 * This is a *different mechanism* from `data-icon-motion` (`icon-motion.ts`),
 * not a variant of it, and the two do not overlap: a motion animates one glyph
 * that stays itself, keyed off its owner's hover; a swap crossfades between two
 * glyphs, keyed off state. An icon can carry both - a Trash2 that hinges its
 * lid on hover does not stop being a Trash2 - so `IconSwap` puts nothing of its
 * own on the caller's element and passes the nodes through untouched.
 *
 * Every twin is `aria-hidden`, including the one that happens to equal the live
 * state: a screen reader must not meet a control's alternative glyph at all.
 * The live node is passed through as the caller wrote it, which for an icon
 * button means whatever `aria-hidden` the caller already had on it - the button
 * is named by `aria-label` and the glyph inside it is decoration either way.
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
