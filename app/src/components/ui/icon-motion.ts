/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The named icon motions, and the one place a call site spells one.
 *
 * An icon motion is CSS only (#1683): the rules live in the `Icon motion` block
 * of `index.css`, keyed on `data-icon-motion="<name>"` on the icon element, and
 * they fire from the `:hover` / `:focus-visible` of the owning
 * `[data-slot="button"]` or `.group` row - never the icon's own hover. Nothing
 * here renders, animates or measures anything; the type exists so that a call
 * site cannot invent a name the stylesheet does not implement, which would be a
 * silently dead attribute rather than a compile error.
 *
 * Why not a `motion` component per icon (the lucide-animated shape): each of
 * those wraps the glyph in a `div`, which breaks `button-variants.ts`'s
 * `[&_svg:not([class*='size-'])]:size-icon` sizing and its
 * `[&_svg]:pointer-events-none`, and JS-driven motion is invisible to both
 * reduced-motion rules at the end of `index.css`. CSS transitions and
 * animations are collapsed by those rules for free.
 *
 * Adding a name means adding the rules to that block in the same commit;
 * `icon-motion.test.ts` holds the two sides together.
 */

/**
 * The motions the stylesheet implements.
 *
 * - `lid` - Trash2. The lid bar and its handle hinge up off the can.
 * - `spinOnce` - RefreshCw. One 360deg turn, as feedback for "do it again".
 * - `rotate90` - Plus, X. A quarter turn; both glyphs are symmetric under it,
 *   so the motion reads as the turn itself rather than as a new shape.
 * - `nudgeX` - ChevronRight. 1px along the direction it points.
 * - `nudgeY` - ChevronDown. The same, vertically.
 * - `scale` - FolderOpen, Braces. The whole glyph grows 10%, for a mark whose
 *   shape offers no part to hinge: one path, or two curves that mean the gap
 *   between them.
 */
export const ICON_MOTION = {
	lid: "lid",
	spinOnce: "spin-once",
	rotate90: "rotate-90",
	nudgeX: "nudge-x",
	nudgeY: "nudge-y",
	scale: "scale",
} as const;

/** One of the names above, as the `data-icon-motion` attribute takes it. */
export type IconMotion = (typeof ICON_MOTION)[keyof typeof ICON_MOTION];
