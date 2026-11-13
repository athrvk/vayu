/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Icon-only buttons must carry an accessible name.
 *
 * An icon-only button has no text node, so without one a screen reader
 * announces nothing but "button". A tooltip does not fix this: Radix supplies
 * `aria-describedby` while the tooltip is open, which is a *description*, not a
 * name - the Dock's four view switchers all had tooltips and still announced as
 * bare buttons.
 *
 * Nine such buttons had drifted in, sitting beside correctly-labelled ones, so
 * this scans the source rather than testing the handful that existed at the
 * time. A new unnamed icon button anywhere in the app fails this test.
 *
 * A name comes from `aria-label` or `aria-labelledby`, never from `title`. A
 * `title` is a name to the accessibility tree but a tooltip only to a pointer:
 * it does not surface on keyboard focus or on touch, so
 * an icon-only button that leans on it teaches a keyboard user nothing. An
 * icon-only button is a `TooltipIconButton` (`aria-label` and the app's Tooltip
 * from one `label`), and the count of icon buttons carrying `title=` at all,
 * beside an `aria-label` or not, is pinned at zero (#3498).
 *
 * Two gaps closed in #1216:
 *
 * - It saw `<Button size="icon">` and nothing else, while 12 raw `<button>`
 *   elements hold an icon and no text. Every one of them is named today; the
 *   scan is here so the thirteenth is not the one that finds out. (A
 *   thirteenth exists and is skipped on purpose: the schema explorer's chevron
 *   is `aria-hidden` and `tabIndex={-1}`, a pointer affordance for an expand
 *   the row already exposes through `aria-expanded` and the arrow keys.)
 * - `title`-only was accepted without limit; #3498 closed the other half.
 */

import { describe, it, expect } from "vitest";
import { blankComments, elements, openingTags, summarize } from "@/lib/jsx-opening-tags.testkit";

const sources = import.meta.glob("/src/**/*.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
});

const isIconButton = (tag: string) => /size=["']icon["']/.test(tag);

const hasAriaName = (tag: string) =>
	/aria-label[=\s]/.test(tag) || /aria-labelledby[=\s]/.test(tag);

const hasTitle = (tag: string) => /\btitle[=\s]/.test(tag);

/**
 * Hidden from assistive technology, so there is no name to give. The tree rows
 * pair a `tabIndex={-1} aria-hidden` chevron with the row's own `aria-expanded`
 * and arrow keys: the button is a pointer affordance for something the keyboard
 * and the screen reader already reach another way.
 */
const isHiddenFromAt = (tag: string) => /aria-hidden[=\s]/.test(tag);

/**
 * Whether a button's children would announce anything.
 *
 * Everything is a text node except an element and an expression that renders
 * only elements: `<Trash2 />` announces nothing, `{label}` announces itself, and
 * `{expanded ? <ChevronDown /> : <ChevronRight />}` is two icons wearing a
 * conditional. The walk skips tags and quoted strings so that a `[&>span]` in a
 * class and a `>` inside an arrow function do not end a tag early - the same
 * hazard `openingTags` exists for.
 *
 * Skipping only the *tag* rather than the element is what makes
 * `<TruncatedText>{request.name}</TruncatedText>` announce: the name is a child
 * expression, and a wrapper around it does not silence it.
 */
function announcesText(children: string): boolean {
	// JSX comments go first and whole: blanking one would leave `{ }`, an empty
	// expression, which reads as a rendered value and so as text.
	const source = blankComments(children.replace(/\{\/\*[\s\S]*?\*\/\}/g, ""));
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (/\s/.test(c)) continue;
		if (c === "<") {
			i = skip(source, i, "<", ">");
			continue;
		}
		if (c === "{") {
			const end = skip(source, i, "{", "}");
			if (expressionAnnouncesText(source.slice(i + 1, end))) return true;
			i = end;
			continue;
		}
		return true; // A bare text node.
	}
	return false;
}

/**
 * The same question inside `{ … }`, where the rules invert: what is *not* in an
 * element is code, and code announces nothing.
 *
 * So an expression with no JSX renders a value (`{label}`), and one with JSX
 * announces only if something inside those elements does - a nested expression
 * or a string literal, both of which are content rather than control flow. It
 * is a heuristic, and deliberately the cautious one: it over-reports text,
 * which costs coverage, rather than under-reporting it, which would call a
 * labelled button unnamed.
 */
function expressionAnnouncesText(code: string): boolean {
	if (!code.includes("<")) return true;

	let outsideTags = "";
	for (let i = 0; i < code.length; i++) {
		if (code[i] === "<") i = skip(code, i, "<", ">");
		else outsideTags += code[i];
	}
	return /[{"'`]/.test(outsideTags);
}

/** The index of the `close` that matches the `open` at `from`, quotes skipped. */
function skip(source: string, from: number, open: string, close: string): number {
	let depth = 0;
	let quote: string | null = null;
	for (let i = from; i < source.length; i++) {
		const c = source[i];
		if (quote) {
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === open) depth++;
		else if (c === close && --depth === 0) return i;
	}
	return source.length;
}

/**
 * The plain `Button`s that are icon-only and carry their label on focus another
 * way, by file and count. Each is wrapped in a `Tooltip` beside it (the trigger
 * is a ref-taking child these files compose by hand). `RowActionsMenu`'s is
 * also a `DropdownMenuTrigger`, and declines the tooltip on the focus the
 * closing menu hands back (`RowActionsMenu.test.tsx`).
 */
const HAND_WRAPPED: Record<string, number> = {
	"components/shared/KeyValueEditor/FilePartCell.tsx": 1,
	"components/shared/KeyValueEditor/KeyValueRow.tsx": 2,
	"components/shared/RowActionsMenu.tsx": 1,
	"components/shared/TimeValue/TimeMarker.tsx": 1,
	"components/shared/response-viewer/ResponseActions.tsx": 2,
	"modules/collections/CollectionTree.tsx": 3,
};

describe("icon-only buttons have accessible names", () => {
	const iconTags = Object.entries(sources).flatMap(([path, src]) =>
		openingTags(src as string, "Button")
			.filter(isIconButton)
			.map((tag) => ({ path, tag }))
	);

	it("finds icon buttons to check (guards the scan itself)", () => {
		// A renamed primitive or a broken glob would match nothing, and every
		// assertion below would then vacuously pass. The floor only has to be
		// clear of zero - kept well below the real count so removing a button
		// (e.g. the run header's back button) does not trip the guard.
		expect(iconTags.length).toBeGreaterThan(5);
	});

	it("names every icon-only Button", () => {
		const offenders = iconTags
			.filter(({ tag }) => !hasAriaName(tag))
			.map(({ path, tag }) => summarize(path, tag));
		expect(offenders).toEqual([]);
	});

	const rawIconButtons = Object.entries(sources).flatMap(([path, src]) =>
		elements(src as string, "button")
			.filter(({ tag, children }) => !isHiddenFromAt(tag) && !announcesText(children))
			.map(({ tag }) => ({ path, tag }))
	);

	it("finds raw icon-only <button> elements to check", () => {
		// 12 when this was written, across 42 files that hold a raw `<button>`.
		expect(rawIconButtons.length).toBeGreaterThan(5);
	});

	it("names every raw icon-only <button>", () => {
		const offenders = rawIconButtons
			.filter(({ tag }) => !hasAriaName(tag))
			.map(({ path, tag }) => summarize(path, tag));
		expect(offenders).toEqual([]);
	});

	it("shows every icon-only Button's label on focus: it is a TooltipIconButton or wrapped by hand", () => {
		// `TooltipIconButton` spells no `size="icon"` at its call sites, so a plain
		// `<Button size="icon">` reaching this scan is one a keyboard user gets no
		// visible label from, unless the file wraps it in a `Tooltip` itself. The
		// count per file is pinned, so a new bare one beside an already-wrapped
		// one still fails (#3498). Only `size="icon"` is read: whether a
		// `size="sm"` button holds text is not something a scan can tell.
		const counts = new Map<string, number>();
		for (const { path, tag } of iconTags) {
			if (path.includes(".test.") || isHiddenFromAt(tag)) continue;
			const file = path.replace(/^\/src\//, "");
			counts.set(file, (counts.get(file) ?? 0) + 1);
		}

		expect(Object.fromEntries([...counts].sort())).toEqual(HAND_WRAPPED);
	});

	it("gives no icon-only button a native title", () => {
		const titled = [...iconTags, ...rawIconButtons]
			.filter(({ tag }) => hasTitle(tag))
			.map(({ path, tag }) => summarize(path, tag));
		// A zero ceiling, not a cap: the tooltip is `TooltipIconButton`'s, and a
		// `title` beside it would show twice on hover.
		expect(titled).toEqual([]);
	});
});
