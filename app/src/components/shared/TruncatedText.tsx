/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TruncatedText
 *
 * One line of user-supplied text - a collection, request, environment or tab
 * name - that ellipses when it does not fit and reveals the full value on
 * hover, only then.
 *
 * This is the single place that behaviour lives. The alternative was
 * `title={name}` written out at every call site, which drifts: some rows get
 * it, some do not, and the ones that do show a tooltip even when the name is
 * fully visible.
 *
 * Distinct from `ScrollOnOverflow`, which marquees the text instead. That is
 * the tab-strip treatment, where the label is the primary target and there is
 * no room to widen. Rows ellipse and use a tooltip; they should not animate
 * under the cursor.
 */

import { useOverflowTitle } from "@/hooks/useOverflowTitle";
import { cn } from "@/lib/utils";

interface TruncatedTextProps {
	/** The full text. Shown inline, and as the tooltip when it does not fit. */
	children: string;
	className?: string;
	/** Element to render as. Defaults to `span`. */
	as?: "span" | "div" | "h1" | "h2" | "h3" | "p";
}

export function TruncatedText({ children, className, as: Tag = "span" }: TruncatedTextProps) {
	const ref = useOverflowTitle<HTMLElement>(children);

	return (
		// `truncate` is not optional - `scrollWidth > clientWidth` only means
		// "clipped" when the element hides its overflow, so the hook cannot
		// detect anything without it. Nor is `block`: overflow and
		// `text-overflow` do nothing on an inline box, so the default `span`
		// under a non-flex parent (the Trash row) ran past its column, clipped
		// mid-word by the row with no ellipsis and no tooltip. A flex or grid
		// child is blockified anyway, so this changes nothing there.
		<Tag ref={ref as React.Ref<never>} className={cn("block truncate", className)}>
			{children}
		</Tag>
	);
}
