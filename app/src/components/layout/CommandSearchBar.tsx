/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The title row's search bar - the palette's visible entry point.
 *
 * **It is a trigger, never a second search implementation.** It looks like an
 * input because that is what makes it findable (the owner's complaint was that
 * nobody would ever discover ⌘K), but typing happens in the palette's own
 * field: a real input here would mean two query states, two ranked lists and
 * two sets of sources to keep in step, which is the defect this repo names most
 * often. So it is a `<button>` wearing an input's clothes, and one click hands
 * the whole job to `CommandPalette`.
 *
 * The chord it advertises comes from `PALETTE_CHORD`, the same constant the
 * palette's own listener matches on - `constants/shortcuts.ts` exists so a
 * control cannot claim a combination nothing listens for.
 *
 * **It needs no `isModalOpen()` guard, unlike the chord path** (#1691). The two
 * are not symmetric: a window-level chord fires wherever focus is, while this is
 * a click on a control that an open dialog has already taken out of reach.
 * Measured in Chromium against the app's own `DialogContent`: Radix sets
 * `pointer-events: none` on `body` and paints the overlay above this button, so
 * a real click never lands; it marks everything outside the dialog
 * `aria-hidden`, so the button is not in the accessibility tree; and the focus
 * trap keeps Tab inside the dialog. Only a scripted `element.click()` reaches
 * the handler, which is not a path a user has. A guard here would be dead code
 * defending a door the dialog has already locked.
 */

import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores";
import { PALETTE_CHORD } from "@/constants/shortcuts";
import { formatChord } from "@/lib/platform";
import { ICON_MOTION } from "@/components/ui";

export function CommandSearchBar({ className }: { className?: string }) {
	const setPaletteOpen = useLayoutStore((s) => s.setPaletteOpen);

	return (
		<button
			type="button"
			onClick={() => setPaletteOpen(true)}
			// The accessible name says what the control does; the placeholder text
			// inside it is decoration for the eye, and a screen reader announcing
			// "Search" twice is worse than announcing the action once.
			aria-label="Search everything"
			// The title row is a drag region; a control inside it has to opt out or
			// the pointer moves the window instead of pressing the button.
			style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			className={cn(
				// `h-target` (issue #1679, 24px - was `h-6`/18px, under the WCAG 2.2
				// SC 2.5.8 floor) in the 32px title row: 4px of air above and below,
				// the same gutter the environment switcher opposite it leaves.
				"group flex h-target w-full items-center gap-2 rounded-md border border-input px-2",
				// Sunken against --panel, so it reads as a field rather than as a
				// button: the title row is the panel surface, and a control painted
				// in the same colour as its bar has no edge to be found by.
				// `group`: the Search glyph's `wiggle` fires from this button's
				// own hover, and the `Icon motion` block gates every rule on a
				// `[data-slot="button"]` or `.group` ancestor. This is
				// hand-rolled and is neither without the class.
				"group bg-background text-xs text-muted-foreground",
				// Explicit property list, not `transition-colors`: this is a
				// hand-rolled button with no `[data-slot="button"]`, so it misses the
				// baseline's `scale` press-feedback transition (`index.css`) - added
				// here instead, same duration as the colour properties.
				"transition-[background-color,color,border-color,opacity,scale] duration-150 active:scale-[0.98]",
				"hover:bg-accent hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				className
			)}
		>
			<Search className="size-icon-sm shrink-0" data-icon-motion={ICON_MOTION.wiggle} />
			<span className="flex-1 truncate text-left">Search</span>
			{/* The hint is the reason the bar earns its width: a user who learns the
			    chord here never needs the bar again. */}
			<kbd className="shrink-0 font-mono text-micro tracking-tight opacity-70">
				{formatChord(PALETTE_CHORD)}
			</kbd>
		</button>
	);
}
