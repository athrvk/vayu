/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The scale's custom steps, told to tailwind-merge as *sizes*.
 *
 * `text-<something>` is a font size or a text colour, and tailwind-merge tells them apart from a
 * list of names it ships: an unknown one is read as a colour. Unregistered,
 * `cn("text-hero ...", "text-foreground")` drops the size and leaves the hero metric rendering at
 * body size, silently, because the class is simply not in the output (#1409). `text-md` survives
 * the same shape only because "md" is already a size label it knows, and `text-sm` because it is
 * stock; a step named for what it is for is exactly the case that breaks.
 *
 * The chrome/target/icon floor steps (#1679) are the same defect in the other direction:
 * `h-control-sm`, `size-target` and the rest are unknown to tailwind-merge's height/width/size
 * groups, so unregistered, `cn("h-control-sm", "h-6")` (a Button's own size variant next to a
 * caller's override) keeps *both* classes instead of dropping the earlier one. Tailwind's generated
 * stylesheet then decides by declaration order rather than the caller's intent, and `.h-control-sm`
 * sorts after `.h-6`, so the override silently loses.
 *
 * Registered here rather than worked around at the call sites: every `text-hero`/`text-metric` and
 * every `h-band`, `h-banner`, `h-control`, `h-control-sm`, `h-control-xs`, `h-target`,
 * `size-target`, `size-control-sm`, `size-icon` and `size-icon-sm` in the app goes through `cn()`
 * or a plain string, and a call site that "knows" about the merge order is the kind of hand-rolled
 * copy this repo keeps out of components.
 */
const FLOOR_STEPS = [
	"band",
	"band-md",
	"band-lg",
	"banner",
	"control",
	"control-sm",
	"control-xs",
	"target",
] as const;
const ICON_STEPS = ["target", "icon", "icon-sm"] as const;
// An icon button that must span a `control-sm` neighbour (a field beside it)
// states `size-control-sm`; it replaces the variant's `size-target`.
const SQUARE_STEPS = [...ICON_STEPS, "control-sm"] as const;

const twMerge = extendTailwindMerge({
	extend: {
		classGroups: {
			"font-size": [{ text: ["hero", "metric", "label", "micro"] }],
			h: [{ h: [...FLOOR_STEPS] }],
			"min-h": [{ "min-h": ["band", "band-md", "band-lg", "banner"] }],
			w: [{ w: [...FLOOR_STEPS] }],
			"min-w": [{ "min-w": ["target"] }],
			size: [{ size: [...SQUARE_STEPS] }],
		},
	},
});

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
