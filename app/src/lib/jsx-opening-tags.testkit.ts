/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Pull complete JSX opening tags for one component out of a source file.
 *
 * A regex cannot do this: JSX props hold arrow functions (`onClick={(e) => …}`)
 * and object literals whose `>` and `}` end a naive match early - which is
 * exactly the bug that made an earlier icon-button guard flag buttons that were
 * already labelled. So the cursor tracks `{}` nesting and string literals, and
 * ends a tag only at a top-level `>`.
 *
 * It lives here, beside no single guard, because a second guard now needs it
 * (`code-editor.aria-label.test.tsx`) and a hand-rolled copy of this scanner
 * would not receive the fix above - the repeat defect `app/CLAUDE.md` names.
 */

/**
 * Comments blanked to spaces, strings left alone, every offset preserved.
 *
 * A source scan that walks characters has to do this first, and the reason is
 * `// The join: this member's own border` inside a JSX tag: the apostrophe
 * opened a string literal the walk never closed, so the tag ran to the end of
 * the file and the element's children came out empty. A blanked copy keeps
 * every index equal to the original, so a caller can scan one and slice the
 * other. `//` inside a string (`"https://…"`) is not a comment, which is why
 * this cannot be four regexes.
 */
export function blankComments(src: string): string {
	const out = src.split("");
	let quote: string | null = null;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			quote = c;
			continue;
		}
		if (c !== "/") continue;
		const line = src[i + 1] === "/";
		const block = src[i + 1] === "*";
		if (!line && !block) continue;
		const end = line
			? (src.indexOf("\n", i) + 1 || src.length + 1) - 1
			: src.indexOf("*/", i) + 2 || src.length;
		for (let j = i; j < end; j++) if (out[j] !== "\n") out[j] = " ";
		i = end - 1;
	}
	return out.join("");
}

/**
 * Which characters sit inside a string or template literal, by index.
 *
 * Every scan here has to skip literal contents - a `>` in `[&>span]`, a `(` in
 * an `origin-[…]` class, a `{` in a `data-[state=open]` variant - and this is
 * the one place that decides what "inside a literal" means. It is meant for
 * comment-blanked source: on raw source the apostrophe in `member's` is
 * indistinguishable from an opening quote, which is the bug `blankComments`
 * exists for, so blank first and mask second.
 */
export function literalMask(src: string): boolean[] {
	const inLiteral = new Array<boolean>(src.length).fill(false);
	let quote: string | null = null;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quote) {
			inLiteral[i] = true;
			if (c === "\\") {
				if (i + 1 < src.length) inLiteral[i + 1] = true;
				i++;
			} else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			quote = c;
			inLiteral[i] = true;
		}
	}
	return inLiteral;
}

/**
 * Every `<Name ...>` opening tag in `src`, each returned whole - from the `<`
 * to the `>` that closes it, self-closing or not.
 *
 * `Name` is matched on a word boundary, so `<Button` does not also collect
 * `<ButtonGroup`.
 */
export function openingTags(src: string, name: string): string[] {
	return tagRanges(src, name).map(({ start, end }) => src.slice(start, end + 1));
}

/** Where one opening tag starts and where its `>` sits. */
interface TagRange {
	readonly start: number;
	readonly end: number;
}

function tagRanges(source: string, name: string): TagRange[] {
	// Structure is read from the blanked copy; the caller slices the original.
	const src = blankComments(source);
	const inLiteral = literalMask(src);
	const ranges: TagRange[] = [];
	const re = new RegExp(`<${name}\\b`, "g");
	let match: RegExpExecArray | null;
	while ((match = re.exec(src))) {
		let depth = 0; // {} nesting
		let i = match.index + match[0].length;
		for (; i < src.length; i++) {
			if (inLiteral[i]) continue;
			const c = src[i];
			if (c === "{") depth++;
			else if (c === "}") depth--;
			else if (c === ">" && depth === 0) break;
		}
		ranges.push({ start: match.index, end: i });
	}
	return ranges;
}

/** An element: its opening tag, and the source between that tag and its close. */
export interface JsxElement {
	readonly tag: string;
	readonly children: string;
}

/**
 * Every `<Name …>` element, each with the source of its children - empty for a
 * self-closing tag.
 *
 * What a button *contains* is what decides whether it needs an `aria-label`, and
 * the opening tag alone cannot say (`icon-button-labels.test.tsx`). Nesting is
 * counted rather than assumed away: `<button>` cannot legally hold another, but
 * the walk is three lines and a wrong close is a silent wrong verdict.
 */
export function elements(source: string, name: string): JsxElement[] {
	const close = `</${name}>`;
	// The same split as `tagRanges`: a `</button>` written inside a comment is
	// not a close tag, and blanking keeps every index usable against the source.
	const src = blankComments(source);
	return tagRanges(source, name).map(({ start, end }) => {
		const tag = source.slice(start, end + 1);
		if (tag.endsWith("/>")) return { tag, children: "" };

		let depth = 1;
		let cursor = end + 1;
		const open = new RegExp(`<${name}\\b`, "g");
		while (depth > 0 && cursor < src.length) {
			open.lastIndex = cursor;
			const nested = open.exec(src);
			const closed = src.indexOf(close, cursor);
			if (closed === -1) return { tag, children: source.slice(end + 1) };
			if (nested && nested.index < closed) {
				depth++;
				cursor = nested.index + nested[0].length;
				continue;
			}
			depth--;
			if (depth === 0) return { tag, children: source.slice(end + 1, closed) };
			cursor = closed + close.length;
		}
		return { tag, children: "" };
	});
}

/** A tag flattened to one line, for a readable failure message. */
export function summarize(path: string, tag: string, max = 90): string {
	return `${path}: ${tag.replace(/\s+/g, " ").slice(0, max)}`;
}
