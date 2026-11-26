/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The title row's search bar, the palette's visible entry point.
 *
 * **A trigger, never a second search.** It looks like an input so it is findable (the owner's
 * complaint: nobody would discover ⌘K), but typing happens in the palette's field: a real input
 * here would mean two query states, two ranked lists and two source sets to keep in step. So it is
 * a `<button>` dressed as an input, and a click hands the job to `CommandPalette`.
 *
 * The chord it shows is `PALETTE_CHORD`, the constant the palette's listener matches, so the
 * control cannot advertise a combination nothing listens for (`constants/shortcuts.ts`).
 *
 * **No `isModalOpen()` guard, unlike the chord path** (#1691): a window-level chord fires wherever
 * focus is, but this is a click on a control an open dialog has already put out of reach. Measured
 * in Chromium against the app's `DialogContent`: Radix sets `pointer-events: none` on `body` and
 * paints the overlay above, so a real click never lands; it marks everything outside the dialog
 * `aria-hidden`, so the button leaves the accessibility tree; and the focus trap keeps Tab inside
 * the dialog. Only a scripted `element.click()` reaches the handler, which no user has.
 */

import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores";
import { PALETTE_CHORD } from "@/constants/shortcuts";
import { chordKeys } from "@/lib/platform";
import { ICON_MOTION, Kbd } from "@/components/ui";

export function CommandSearchBar({ className }: { className?: string }) {
	const setPaletteOpen = useLayoutStore((s) => s.setPaletteOpen);

	return (
		<button
			type="button"
			onClick={() => setPaletteOpen(true)}
			// The name says what the control does; the placeholder text is for the eye, and
			// "Search" announced twice is worse than the action announced once.
			aria-label="Search everything"
			// The title row is a drag region; without the opt-out the pointer moves the window
			// instead.
			style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			className={cn(
				// `h-target` (24px, #1679; `h-6` was 18px, under the WCAG 2.2 SC 2.5.8 floor) in
				// the 32px title row: 4px above and below, the gutter the environment switcher
				// opposite leaves.
				"group flex h-target w-full items-center gap-2 rounded-md border border-input px-2",
				// Sunken against --panel so it reads as a field: the title row is the panel
				// surface, and a control in its bar's colour has no edge to find. `group`: the
				// Search glyph's `wiggle` fires from this button's hover, and the `Icon motion`
				// block gates every rule on a `[data-slot="button"]` or `.group` ancestor, which
				// this hand-rolled button is not without the class.
				"group bg-background text-xs text-muted-foreground",
				// Explicit list, not `transition-colors`: a hand-rolled button has no
				// `[data-slot="button"]`, so it misses the baseline's `scale` press transition
				// (`index.css`), added here at the colours' duration.
				"transition-[background-color,color,border-color,opacity,scale] duration-150 active:scale-[0.98]",
				"hover:bg-accent hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				className
			)}
		>
			<Search className="size-icon-sm shrink-0" data-icon-motion={ICON_MOTION.wiggle} />
			<span className="flex-1 truncate text-left">Search</span>
			{/*
			 * The hint earns the bar its width: a user who learns the chord here never needs the
			 * bar again. Hidden by CSS below a 46rem window, never removed: from there the bar is
			 * under 10rem wide (see TitleBar) and the caps would overflow it.
			 */}
			<span className="flex shrink-0 items-center gap-1 max-[46rem]:hidden">
				{chordKeys(PALETTE_CHORD).map((cap) => (
					<Kbd key={cap} size="sm">
						{cap}
					</Kbd>
				))}
			</span>
		</button>
	);
}
