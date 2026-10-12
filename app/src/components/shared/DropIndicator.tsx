/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { cn } from "@/lib/utils";

const LINE_CLASSES = {
	horizontal: { base: "right-2 h-0.5", before: "top-0", after: "bottom-0" },
	vertical: { base: "inset-y-0 w-0.5", before: "left-0", after: "right-0" },
} as const;

/**
 * The 2px `--primary` line a drag draws at the edge it would drop on: across a
 * row in a vertical list, down the side of an item in a horizontal one.
 *
 * Absolutely positioned inside the target, so the host must be `relative`. A
 * horizontal line is inset from the right and starts at `indentPx` from the
 * left; a vertical one spans the host's full height and takes no indent.
 */
export function DropIndicator({
	edge,
	orientation,
	indentPx = 0,
}: {
	edge: "before" | "after";
	orientation: "horizontal" | "vertical";
	indentPx?: number;
}) {
	const line = LINE_CLASSES[orientation];
	return (
		<span
			aria-hidden="true"
			data-drop-indicator={edge}
			className={cn("pointer-events-none absolute bg-primary", line.base, line[edge])}
			style={orientation === "horizontal" ? { left: indentPx } : undefined}
		/>
	);
}
