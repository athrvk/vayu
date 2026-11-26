/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One line of user-supplied text (a collection, request, environment or tab name) that ellipses
 * when it does not fit and reveals the full value on hover, only then: the one home of that
 * behaviour, as `title={name}` per call site drifts and tooltips even fully visible names. Not
 * `ScrollOnOverflow`, which marquees, the tab strip's treatment where the label is the target with
 * no room to widen; rows ellipse and must not animate under the cursor.
 */

import { useOverflowTitle } from "@/hooks/useOverflowTitle";
import { cn } from "@/lib/utils";

interface TruncatedTextProps {
	/** The full text. Shown inline, and as the tooltip when it does not fit. */
	children: string;
	/**
	 * The tooltip instead of the text, for part of a longer label (a name or ancestor prefix whose
	 * tooltip is the whole path); shown only while clipped.
	 */
	title?: string;
	className?: string;
	/** For an `aria-labelledby` that names a row by this text. */
	id?: string;
	/** Element to render as. Defaults to `span`. */
	as?: "span" | "div" | "h1" | "h2" | "h3" | "p";
}

export function TruncatedText({
	children,
	title,
	className,
	id,
	as: Tag = "span",
}: TruncatedTextProps) {
	const ref = useOverflowTitle<HTMLElement>(title ?? children);

	return (
		// `truncate` is required: `scrollWidth > clientWidth` means clipped only when overflow is
		// hidden. So is `block`: overflow and `text-overflow` do nothing on an inline box, so the
		// default `span` under a non-flex parent (the Trash row) ran past its column, clipped
		// mid-word with no ellipsis or tooltip. A flex or grid child is blockified anyway.
		<Tag ref={ref as React.Ref<never>} id={id} className={cn("block truncate", className)}>
			{children}
		</Tag>
	);
}
