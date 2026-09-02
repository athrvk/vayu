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
 * Every `<Name ...>` opening tag in `src`, each returned whole - from the `<`
 * to the `>` that closes it, self-closing or not.
 *
 * `Name` is matched on a word boundary, so `<Button` does not also collect
 * `<ButtonGroup`.
 */
export function openingTags(src: string, name: string): string[] {
	const tags: string[] = [];
	const re = new RegExp(`<${name}\\b`, "g");
	let match: RegExpExecArray | null;
	while ((match = re.exec(src))) {
		let depth = 0; // {} nesting
		let quote: string | null = null;
		let i = match.index + match[0].length;
		for (; i < src.length; i++) {
			const c = src[i];
			if (quote) {
				if (c === quote) quote = null;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") quote = c;
			else if (c === "{") depth++;
			else if (c === "}") depth--;
			else if (c === ">" && depth === 0) break;
		}
		tags.push(src.slice(match.index, i + 1));
	}
	return tags;
}

/** A tag flattened to one line, for a readable failure message. */
export function summarize(path: string, tag: string, max = 90): string {
	return `${path}: ${tag.replace(/\s+/g, " ").slice(0, max)}`;
}
