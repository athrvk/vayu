/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one way to show an HTTP method, so method colour, one of the app's strongest signals, means
 * the same everywhere (seven renderings had drifted, one losing an unknown method's colour to a
 * missing `getMethodColor` fallback).
 *
 * The `badge` variant is a fixed-width column, not a chip growing with its letters: rows put the
 * badge first, so an intrinsic chip started names at a different x per method, a ragged edge down
 * every list. Three decisions hold the column:
 *
 * 1. **Width** is `BADGE_METHOD_CHARS` characters plus the chip's padding and border, in `ch` so it
 *    tracks the mono font and one class covers both sizes. Five keeps `PATCH` whole; the three
 *    longer standard methods are abbreviated `DEL`, `OPT`, `CONN` by `getMethodDisplayLabel`, the
 *    forms Postman, Insomnia and Bruno use, so the sidebar gives the name about a third of the row
 *    back rather than paying `7ch` on every row for two rare verbs.
 * 2. **The label is centred**: short methods in a wide chip read better so, the shape every client
 *    uses.
 * 3. **Longer methods truncate** rather than widen the chip: `method` is unbounded at runtime (a
 *    pasted `curl -X PROPPATCH` reaches it through the curl parser's type assertion, a stored run's
 *    method is a `string`), so one exotic verb must not misalign every row. The full method is the
 *    `title`, as for an abbreviation (`DEL` titled `DELETE`).
 *
 * The width is not an opt-in prop: the drift above is the argument for the primitive enforcing it.
 * The `text` variant keeps intrinsic width, inline in running text (tabs), where a column would
 * punch holes; a caller wanting one sets its own. The collections tree row is the second sanctioned
 * caller-set column (after the import preview): a bordered chip per row competed with the tree's
 * hover fill and selection ring, so it uses `variant="text"` in a `w-[5ch]` container, colour alone
 * carrying the signal.
 */

import { getMethodColor, getMethodDisplayLabel } from "@/lib/method-display";
import { cn } from "@/lib/utils";

/**
 * The longest standard method label kept whole, `PATCH` (`DELETE`, `OPTIONS`, `CONNECT` reach the
 * chip as `DEL`, `OPT`, `CONN`). Keep in step with the `5ch` literal below, which Tailwind must
 * see.
 */
const BADGE_METHOD_CHARS = 5;

interface MethodBadgeProps {
	method: string;
	/**
	 * - `badge` - tinted chip for list rows and headers where it anchors a line; fixed-width, so
	 *   sibling labels align (see the header).
	 * - `text` - colour only, for dense places (tabs) where chrome would crowd.
	 */
	variant?: "badge" | "text";
	/** 10px for dense rows, 11px where it sits beside body text. */
	size?: "sm" | "md";
	/** Dim in secondary contexts - e.g. an inactive tab. */
	muted?: boolean;
	className?: string;
	/** For an `aria-labelledby` that names a row by this badge's label. */
	id?: string;
}

export function MethodBadge({
	method,
	variant = "badge",
	size = "sm",
	muted = false,
	className,
	id,
}: MethodBadgeProps) {
	const c = getMethodColor(method);
	const upperMethod = method.toUpperCase();
	const { label, abbreviated } = getMethodDisplayLabel(method);
	const isBadge = variant === "badge";
	const isTruncated = isBadge && label.length > BADGE_METHOD_CHARS;

	return (
		<span
			id={id}
			className={cn(
				"font-mono font-semibold uppercase shrink-0 transition-opacity",
				size === "sm" ? "text-micro" : "text-label",
				isBadge &&
					// `5ch` of content plus `px-1.5` and the 1px border: exactly `PATCH` at either
					// size, so every name starts at the same x. `inline-flex` applies the width
					// outside a flex row too and centres the label on both axes.
					"inline-flex items-center justify-center rounded-md border px-1.5 py-0.5 w-[calc(5ch+0.75rem+2px)]",
				muted && "opacity-60",
				className
			)}
			style={
				isBadge
					? {
							color: `hsl(${c})`,
							background: `hsl(${c} / 0.1)`,
							borderColor: `hsl(${c} / 0.3)`,
						}
					: { color: `hsl(${c})` }
			}
			// Only when the chip does not show the whole method (an abbreviation, or a truncated
			// long method). A native tooltip on every chip would fight the app's tooltips on the
			// same rows, so its absence matters as much as its presence.
			title={abbreviated || isTruncated ? upperMethod : undefined}
		>
			{isBadge ? <span className="min-w-0 truncate">{label}</span> : label}
		</span>
	);
}
