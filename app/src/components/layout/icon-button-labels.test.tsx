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
 * A name may come from `aria-label`, `aria-labelledby`, or `title` - all three
 * feed the accessible-name computation, and this codebase uses `title` for it
 * in several places. (title-only is weaker - it does not surface on keyboard
 * focus - but it is a name, and forcing a conversion is a separate decision.)
 *
 * Two gaps closed in #1216:
 *
 * - It saw `<Button size="icon">` and nothing else, while 13 raw `<button>`
 *   elements hold an icon and no text. Every one of them is named today; the
 *   scan is here so the fourteenth is not the one that finds out.
 * - `title`-only was accepted without limit. No site relies on it any more, so
 *   the count is pinned at zero: a *new* icon button gets a real `aria-label`,
 *   which is the half of the name computation that survives keyboard focus.
 *   The three buttons that carry `title` beside an `aria-label` are unaffected
 *   - a redundant tooltip is not a naming decision.
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

const hasAccessibleName = (tag: string) => hasAriaName(tag) || /\btitle[=\s]/.test(tag);

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
			.filter(({ tag }) => !hasAccessibleName(tag))
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
			.filter(({ tag }) => !hasAccessibleName(tag))
			.map(({ path, tag }) => summarize(path, tag));
		expect(offenders).toEqual([]);
	});

	it("adds no new button whose only name is a title", () => {
		const titleOnly = [...iconTags, ...rawIconButtons]
			.filter(({ tag }) => hasAccessibleName(tag) && !hasAriaName(tag))
			.map(({ path, tag }) => summarize(path, tag));
		// The count today is zero. A cap rather than a ban, because the docblock
		// above still holds - `title` is a name, just the weaker one - and this is
		// the ratchet that keeps the weaker one from spreading.
		expect(titleOnly).toEqual([]);
	});
});
