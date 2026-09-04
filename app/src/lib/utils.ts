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
 * `text-<something>` is a font size or a text colour, and tailwind-merge tells
 * them apart from a list of names it ships: an unknown one is read as a colour.
 * So `cn("text-hero ...", "text-foreground")` dropped the size and left the
 * hero metric rendering at body size - silently, because the class simply was
 * not in the output (#1409). `text-md` survived the same shape only because
 * "md" is already one of the size labels it knows, and `text-sm` because it is
 * stock; a step named for what it is for is exactly the case that breaks.
 *
 * Registered here rather than worked around at the call sites: every
 * `text-hero` and `text-metric` in the app goes through `cn()` or a plain
 * string, and a call site that "knows" about the merge order is the kind of
 * hand-rolled copy this repo keeps out of components.
 */
const twMerge = extendTailwindMerge({
	extend: { classGroups: { "font-size": [{ text: ["hero", "metric"] }] } },
});

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
