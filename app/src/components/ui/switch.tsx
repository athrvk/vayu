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
 * The off state needs a visible boundary. Measured on `--card` with transitions frozen, an
 * unchecked switch was 1.55 light / 1.28 dark, the thumb only 1.41 on its track in light: nearly
 * invisible, where WCAG 1.4.11 wants 3.0 for what identifies a component and its state. The fill
 * stays quiet and the reserved 2px transparent border is coloured, so nothing moves.
 * `subtle-foreground` is the faintest tier clearing it (3.17 / 3.34); `muted-foreground` passes
 * (5.61 / 6.77) but reads almost as loud as on.
 *
 * On has the same need in dark: `--primary-fill` is one deep value in both themes, 2.98 on `--card`
 * on aurora, so the border takes `--primary` for the checked edge (at least 5.79 in every dark
 * scheme). In light, ocean and aurora keep `--primary` equal to `--primary-fill`, so the edge is
 * invisible there; other schemes retune it. It stays 2px: 1px would change the unchecked `border-2`
 * and the thumb's 24px travel.
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitives.Root>) {
	return (
		<SwitchPrimitives.Root
			data-slot="switch"
			className={cn(
				// `h-target` (#1679), not `h-5` (15px, under WCAG 2.2 SC 2.5.8's 24x24px). The
				// width is a fixed `44px`: `target` is a square hit box, and a rhythm-scaled width
				// beside a floor height changed the thumb's travel per density; fixed keeps the
				// transform exact.
				"peer inline-flex h-target w-[44px] shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary-fill data-[state=checked]:border-primary data-[state=unchecked]:bg-border-strong data-[state=unchecked]:border-subtle-foreground",
				className
			)}
			{...props}
		>
			<SwitchPrimitives.Thumb
				data-slot="switch-thumb"
				className={cn(
					// `size-icon` (16px): an icon-scale glyph on the track, not a target of its
					// own. The 44px track less 2px border a side leaves 40px; less the thumb, a
					// 24px travel.
					"pointer-events-none block size-icon rounded-full bg-background dark:bg-foreground shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-[24px] data-[state=unchecked]:translate-x-0"
				)}
			/>
		</SwitchPrimitives.Root>
	);
}

export { Switch };
