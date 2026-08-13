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
 */

import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores";
import { PALETTE_CHORD } from "@/constants/shortcuts";
import { formatChord } from "@/lib/platform";

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
				// h-6 in a 32px row: 4px of air above and below, the same gutter the
				// environment switcher opposite it leaves.
				"group flex h-6 w-full items-center gap-2 rounded-md border border-input px-2",
				// Sunken against --panel, so it reads as a field rather than as a
				// button: the title row is the panel surface, and a control painted
				// in the same colour as its bar has no edge to be found by.
				"bg-background text-xs text-muted-foreground transition-colors",
				"hover:bg-accent hover:text-foreground",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				className
			)}
		>
			<Search className="h-3.5 w-3.5 shrink-0" />
			<span className="flex-1 truncate text-left">Search</span>
			{/* The hint is the reason the bar earns its width: a user who learns the
			    chord here never needs the bar again. */}
			<kbd className="shrink-0 font-mono text-[10px] tracking-tight opacity-70">
				{formatChord(PALETTE_CHORD)}
			</kbd>
		</button>
	);
}
