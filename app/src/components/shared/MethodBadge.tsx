/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * MethodBadge
 *
 * The single way to display an HTTP method. It previously rendered seven
 * different ways across the app - three sizes, two weights, some tinted, some
 * with no colour at all - and the history sidebar carried its own copy of the
 * colour logic that omitted `getMethodColor`'s fallback, so an unrecognised
 * method resolved to an undefined custom property and silently lost its colour.
 *
 * Method colour is one of the app's strongest visual signals; it should mean the
 * same thing everywhere it appears.
 *
 * The `badge` variant is a fixed-width column, not a chip that grows with its
 * letters. Sibling rows put the badge first and the name after it, so an
 * intrinsic-width chip started `GET` names at one x, `POST` names at another and
 * `DELETE`/`OPTIONS` further still - a ragged left edge down every list. Three
 * decisions hold that column together:
 *
 * 1. **Width** is `BADGE_METHOD_CHARS` characters plus the chip's own padding
 *    and border, expressed in `ch` so it tracks the mono font the chip already
 *    uses and one class covers both sizes. Five is the longest label that stays
 *    whole (`PATCH`), because the three standard methods longer than that are
 *    substituted for their conventional abbreviations - `DEL`, `OPT`, `CONN` -
 *    through `getMethodDisplayLabel`. The column paid `7ch` on every row for
 *    the two verbs almost nobody has in a tree; at `5ch` the sidebar gives the
 *    request name roughly a third of the row back, and the abbreviations are
 *    the ones Postman, Insomnia and Bruno all use.
 * 2. **The label is centred** inside the chip. Short methods in a wide chip read
 *    better centred than left-aligned against the border, and it is the shape
 *    every other client uses.
 * 3. **Longer methods truncate** rather than widening the chip. `method` is not
 *    bounded at runtime - a pasted `curl -X PROPPATCH` reaches this component
 *    through a type assertion in the curl parser, and a stored run's method is
 *    a plain `string` - so one exotic verb must not re-break the alignment of
 *    every row around it. The full method stays available as the `title`, and
 *    the same rule catches a substitution - the chip shows `DEL`, its title
 *    reads `DELETE`, so the meaning is one hover away.
 *
 * The width is not an opt-in prop: this component's own history (it "previously
 * rendered seven different ways") is the argument for the primitive enforcing
 * the rule. The `text` variant keeps its intrinsic width - it sits inline in
 * running text (tabs), where a fixed column would punch holes, and a caller
 * that wants a column there sets its own width. The collections tree row is
 * the second sanctioned caller-set column (after the import preview): a bordered
 * chip on every row was a second shape competing with the tree's own hover
 * fill and selection ring, so it uses `variant="text"` inside a `w-[5ch]`
 * container and lets colour alone carry the signal.
 */

import { getMethodColor, getMethodDisplayLabel } from "@/utils";
import { cn } from "@/lib/utils";

/**
 * Longest standard HTTP method label that stays whole - `PATCH`. `DELETE`,
 * `OPTIONS` and `CONNECT` are shortened to `DEL`, `OPT` and `CONN` by
 * `getMethodDisplayLabel` before they reach the chip. Kept in step with the
 * `5ch` in the width class below, which Tailwind has to see as a literal.
 */
const BADGE_METHOD_CHARS = 5;

interface MethodBadgeProps {
	method: string;
	/**
	 * `badge` - tinted chip, for list rows and headers where it anchors a line.
	 *   Fixed-width, so sibling labels align; see the note above.
	 * `text` - colour only, for dense places (tabs) where chrome would crowd.
	 */
	variant?: "badge" | "text";
	/** 10px for dense rows, 11px where it sits beside body text. */
	size?: "sm" | "md";
	/** Dim in secondary contexts - e.g. an inactive tab. */
	muted?: boolean;
	className?: string;
}

export function MethodBadge({
	method,
	variant = "badge",
	size = "sm",
	muted = false,
	className,
}: MethodBadgeProps) {
	const c = getMethodColor(method);
	const upperMethod = method.toUpperCase();
	const { label, abbreviated } = getMethodDisplayLabel(method);
	const isBadge = variant === "badge";
	const isTruncated = isBadge && label.length > BADGE_METHOD_CHARS;

	return (
		<span
			className={cn(
				"font-mono font-semibold uppercase shrink-0 transition-opacity",
				size === "sm" ? "text-[10px]" : "text-[11px]",
				isBadge &&
					// `5ch` of content plus this chip's own `px-1.5` and 1px border, so
					// the box is exactly wide enough for `PATCH` (the longest label
					// that stays whole) at either size and the name after it starts at
					// the same x for every method. `inline-flex` makes the width apply
					// outside a flex row too, and centres the label on both axes.
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
			// Only when the chip does not show the whole method: an abbreviated
			// standard method (`DEL`, `OPT`, `CONN`) or a longer method truncated
			// inside the badge column both need the full name one hover away. A
			// native tooltip on every chip would fight the app's own tooltips on
			// the same rows, so the absent case matters as much as the present one.
			title={abbreviated || isTruncated ? upperMethod : undefined}
		>
			{isBadge ? <span className="min-w-0 truncate">{label}</span> : label}
		</span>
	);
}
