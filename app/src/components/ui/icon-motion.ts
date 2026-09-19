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
 * Each one is the thing its glyph *is* (#1707) - a shared `scale` across
 * unrelated marks says nothing about any of them. The geometry each pivot is
 * computed from is written out in the `Icon motion` block beside the rule.
 *
 * - `lid` - Trash2. The lid bar and its handle hinge up off the can.
 * - `hands` - Clock. The hands sweep one full revolution about the dial
 *   centre; the dial stays.
 * - `waves` - Radio. The four arcs travel outward and fade, inner pair then
 *   outer pair; the centre dot stays.
 * - `spread` - Braces. The two curves part by 1px each and close again.
 * - `tilt` - FolderOpen. Tips -6deg about its bottom-left corner with a 4%
 *   grow, the way a folder opens toward you.
 * - `wiggle` - Search. -8deg, +8deg, back, about the lens centre.
 * - `drop` - Download. The arrow drops 2px into its tray; the tray stays.
 * - `lift` - Upload. The arrow rises 2px out of its tray; the tray stays.
 * - `press` - Save. The whole glyph goes to 92% and back, a button pressed.
 * - `tilt-pin` - Pin. Leans -20deg off its own point and rights itself.
 * - `ring` - Bell. A decaying swing about the point it hangs from.
 * - `spin-once` - RefreshCw. One 360deg turn, as feedback for "do it again".
 * - `spin-back` - RotateCcw. The same turn the other way, for "put it back".
 * - `flash` - Zap. Dims to 40% and back with a 6% grow.
 * - `rotate90` - Plus, X. A quarter turn; both glyphs are symmetric under it,
 *   so the motion reads as the turn itself rather than as a new shape.
 * - `nudgeX` - ChevronRight. 1px along the direction it points.
 * - `nudgeY` - ChevronDown. The same, vertically.
 * - `scale` - Play. The whole glyph grows 10% - the last resort for a mark
 *   that is one path with no reading of its own to act out.
 */
export const ICON_MOTION = {
	lid: "lid",
	hands: "hands",
	waves: "waves",
	spread: "spread",
	tilt: "tilt",
	wiggle: "wiggle",
	drop: "drop",
	lift: "lift",
	press: "press",
	tiltPin: "tilt-pin",
	ring: "ring",
	spinOnce: "spin-once",
	spinBack: "spin-back",
	flash: "flash",
	rotate90: "rotate-90",
	nudgeX: "nudge-x",
	nudgeY: "nudge-y",
	scale: "scale",
} as const;

/** One of the names above, as the `data-icon-motion` attribute takes it. */
export type IconMotion = (typeof ICON_MOTION)[keyof typeof ICON_MOTION];
