/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two halves of `heading-level.ts`'s outline (#3498): a `Heading` takes its element from it,
 * and a `HeadingSection` moves it a level down for what it wraps.
 */

import { createElement, type ComponentProps, type ReactNode } from "react";
import {
	HeadingLevelContext,
	useHeadingLevel,
	type HeadingLevel,
	type HeadingTag,
} from "./heading-level";

/**
 * Headings inside sit at `level`, or one below the heading introducing this section; place it right
 * after that heading, around what it titles.
 */
export function HeadingSection({ level, children }: { level?: HeadingLevel; children: ReactNode }) {
	const parent = useHeadingLevel();
	const next = level ?? (Math.min((parent ?? 1) + 1, 6) as HeadingLevel);
	return <HeadingLevelContext.Provider value={next}>{children}</HeadingLevelContext.Provider>;
}

interface HeadingProps extends ComponentProps<"h2"> {
	/**
	 * What it renders as without an outline, named per caller as it differs: a card title is still
	 * a heading, an empty state's line a paragraph, a crumb text.
	 */
	outside: HeadingTag | "p" | "span";
	/** Pins the element regardless of the outline - a card that is its own page. */
	as?: HeadingTag;
}

/** A title at the outline's level: `h{level}` inside it, `outside` beyond it. */
export function Heading({ outside, as, ...props }: HeadingProps) {
	const level = useHeadingLevel();
	// `createElement`, not a capitalised JSX variable: the tag is a string, and the hooks lint
	// reads a component chosen during render as created during it.
	return createElement(as ?? (level === null ? outside : `h${level}`), props);
}
