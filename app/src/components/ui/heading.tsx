/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two halves of the heading outline `heading-level.ts` describes: a
 * `Heading` takes its element from the outline, and a `HeadingSection` moves
 * the outline one level down for what it wraps (#3498).
 */

import { createElement, type ComponentProps, type ReactNode } from "react";
import {
	HeadingLevelContext,
	useHeadingLevel,
	type HeadingLevel,
	type HeadingTag,
} from "./heading-level";

/**
 * Headings inside sit at `level`, or one below the heading that introduces
 * this section. Placed right after that heading, around what it titles.
 */
export function HeadingSection({ level, children }: { level?: HeadingLevel; children: ReactNode }) {
	const parent = useHeadingLevel();
	const next = level ?? (Math.min((parent ?? 1) + 1, 6) as HeadingLevel);
	return <HeadingLevelContext.Provider value={next}>{children}</HeadingLevelContext.Provider>;
}

interface HeadingProps extends ComponentProps<"h2"> {
	/**
	 * What it renders as where there is no outline. Each caller names its own,
	 * because what a title is there differs: a card title is still a heading, an
	 * empty state's line is a paragraph, a crumb is text.
	 */
	outside: HeadingTag | "p" | "span";
	/** Pins the element regardless of the outline - a card that is its own page. */
	as?: HeadingTag;
}

/** A title at the outline's level: `h{level}` inside it, `outside` beyond it. */
export function Heading({ outside, as, ...props }: HeadingProps) {
	const level = useHeadingLevel();
	// `createElement`, not a capitalised variable in JSX: the tag is a string,
	// and the hooks lint reads a component chosen during render as one created
	// during it.
	return createElement(as ?? (level === null ? outside : `h${level}`), props);
}
