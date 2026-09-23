/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

/*
 * The off state needs a visible boundary of its own.
 *
 * Measured against `--card` with transitions frozen, an unchecked switch was
 * 1.55 in light and 1.28 in dark - and in light the thumb was only 1.41 against
 * its own track, so the whole control was close to invisible. WCAG 1.4.11 wants
 * 3.0 for the visual information that identifies a component and its state.
 *
 * The fill stays quiet - an off switch should not shout - and the already
 * reserved 2px transparent border is coloured instead, so nothing moves or
 * resizes. `subtle-foreground` is the faintest tier that clears the bar (3.17
 * light / 3.34 dark); `muted-foreground` would pass at 5.61/6.77 but reads
 * almost as loudly as the on state.
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitives.Root>) {
	return (
		<SwitchPrimitives.Root
			data-slot="switch"
			className={cn(
				// `h-target` (issue #1679), not `h-5`: every toggle in Settings was a
				// 15px interactive control, under the WCAG 2.2 SC 2.5.8 24x24px
				// floor. The track's own width is a fixed `44px` - `target`
				// describes a roughly-square hit box, not an elongated toggle track,
				// and a rhythm-scaled width paired with a fixed-floor height made
				// the thumb's travel distance a different fraction of the track at
				// each density; fixed keeps both ends of the transform exact.
				"peer inline-flex h-target w-[44px] shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-border-strong data-[state=unchecked]:border-subtle-foreground",
				className
			)}
			{...props}
		>
			<SwitchPrimitives.Thumb
				data-slot="switch-thumb"
				className={cn(
					// `size-icon` (16px, was `h-4 w-4`/12px) - the thumb reads as an
					// icon-scale glyph on the track, not a target of its own. The
					// 44px track less its 2px border each side leaves 40px inside;
					// less the 16px thumb, the full travel is 24px.
					"pointer-events-none block size-icon rounded-full bg-background dark:bg-foreground shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-[24px] data-[state=unchecked]:translate-x-0"
				)}
			/>
		</SwitchPrimitives.Root>
	);
}

export { Switch };
