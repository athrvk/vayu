/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The named icon motions, and the one place a call site spells one. A motion is CSS only (#1683):
 * the rules are in `index.css`'s `Icon motion` block, keyed on `data-icon-motion="<name>"` on the
 * icon, firing from the owning `[data-slot="button"]` or `.group` row's `:hover` /
 * `:focus-visible`, never the icon's own. Nothing here renders or animates; the type stops a call
 * site inventing a name the stylesheet lacks, a silently dead attribute. Not a `motion` component
 * per icon (the lucide-animated shape): each wraps the glyph in a `div`, breaking
 * `button-variants.ts`'s `[&_svg:not([class*='size-'])]:size-icon` and
 * `[&_svg]:pointer-events-none`, and JS motion escapes both reduced-motion rules at the end of
 * `index.css`, which collapse CSS motion for free. A new name adds its rules to that block in the
 * same commit; `icon-motion.test.ts` holds both sides.
 */

/**
 * The motions the stylesheet implements, each acting out what its glyph *is* (#1707): a shared
 * `scale` across unrelated marks says nothing. Each pivot's geometry is written beside its rule.
 *
 * - `lid` - Trash2. The lid bar and handle hinge up off the can.
 * - `hands` - Clock. The hands sweep one revolution about the centre; the dial stays.
 * - `waves` - Radio. The four arcs travel outward and fade, inner pair then outer; the dot stays.
 * - `spread` - Braces. The curves part 1px each and close.
 * - `tilt` - FolderOpen. Tips -6deg about its bottom-left corner with a 4% grow, opening toward
 *   you.
 * - `wiggle` - Search. -8deg, +8deg, back, about the lens centre.
 * - `drop` - Download. The arrow drops 2px into its tray; the tray stays.
 * - `lift` - Upload. The arrow rises 2px out of its tray; the tray stays.
 * - `press` - Save. The glyph goes to 92% and back, a button pressed.
 * - `tilt-pin` - Pin. Leans -20deg off its point and rights itself.
 * - `ring` - Bell. A decaying swing about the point it hangs from.
 * - `bob` - Info. A 1.5px rise and settle, for a mark with nothing to hinge and no direction.
 * - `part` - Code2, Code. The chevrons part 1px each; not `spread`, which reads wrong on a glyph
 *   lucide draws right-to-left.
 * - `tiles` - LayoutDashboard. The tiles step 1px from the centre and back, diagonal pairs
 *   staggered.
 * - `sweep` - Gauge. The needle swings -70deg about its hub and returns.
 * - `plug-in` - Plug. 1.5px along the prongs' axis, up.
 * - `pulse` - Network. The three nodes swell 18% in turn, top first.
 * - `trace` - Activity. Stroked on from its left end over a measured path length.
 * - `stack` - Database. The top disc lifts off.
 * - `spin-once` - RefreshCw. One 360deg turn, for "do it again".
 * - `spin-back` - RotateCcw. The same turn backwards, for "put it back".
 * - `flash` - Zap. Dims to 40% and back with a 6% grow.
 * - `rotate90` - Plus, X. A quarter turn; both are symmetric under it, so it reads as the turn.
 * - `nudgeX` - ChevronRight. 1px the way it points.
 * - `nudgeY` - ChevronDown. The same, vertically.
 * - `scale` - Play. Grows 10%, the last resort for a one-path mark with nothing to act out.
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
	bob: "bob",
	part: "part",
	tiles: "tiles",
	sweep: "sweep",
	plugIn: "plug-in",
	pulse: "pulse",
	trace: "trace",
	stack: "stack",
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
