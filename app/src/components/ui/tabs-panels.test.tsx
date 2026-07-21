/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every TabsTrigger must have a TabsContent with the same value.
 *
 * Radix derives each trigger's `aria-controls` from its `value`, so a trigger
 * without a matching panel advertises an element id that does not exist. The
 * failure is invisible: the tabs still look and click correctly, and only the
 * accessibility tree shows a tablist whose panels are missing.
 *
 * That made it easy to get wrong three separate ways in this codebase — the
 * request tabs and the response viewer both rendered their content in a plain
 * <div> outside the Tabs tree (6 and 4 dangling references), and a first pass
 * at ImportModal rendered a single panel for the active value only, leaving the
 * other two triggers dangling. Hence a test rather than a convention.
 *
 * Matching is per file and on the raw `value` text, so a literal (`value="body"`)
 * matches a literal and an expression (`value={tab.id}`) matches the same
 * expression — which is what a trigger/content pair rendered from one `.map()`
 * looks like.
 */

import { describe, it, expect } from "vitest";

const sources = import.meta.glob("/src/**/*.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
});

/**
 * Opening tags for `component`. Scans with a brace/string-aware cursor rather
 * than a regex: JSX props hold arrow functions and object literals whose `>`
 * and `}` end a naive match early.
 */
function openingTags(src: string, component: string): string[] {
	const tags: string[] = [];
	const re = new RegExp(`<${component}\\b`, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		let depth = 0;
		let quote: string | null = null;
		let i = m.index + m[0].length;
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
		tags.push(src.slice(m.index, i + 1));
	}
	return tags;
}

/** The raw text of a `value=` prop — `"body"` or `{tab.id}`. */
function valueOf(tag: string): string | null {
	const literal = tag.match(/\bvalue=("[^"]*"|'[^']*')/);
	if (literal) return literal[1].slice(1, -1);
	const expr = tag.match(/\bvalue=(\{[^}]*\})/);
	return expr ? expr[1] : null;
}

const files = Object.entries(sources)
	.filter(([path]) => !path.includes(".test."))
	.map(([path, src]) => ({
		path,
		triggers: openingTags(src as string, "TabsTrigger")
			.map(valueOf)
			.filter(Boolean) as string[],
		contents: openingTags(src as string, "TabsContent")
			.map(valueOf)
			.filter(Boolean) as string[],
	}))
	.filter((f) => f.triggers.length > 0);

describe("every TabsTrigger has a matching TabsContent", () => {
	it("finds tab triggers to check (guards the scan itself)", () => {
		// A renamed primitive or a broken glob would match nothing, and the
		// assertion below would pass vacuously.
		const total = files.reduce((n, f) => n + f.triggers.length, 0);
		expect(total).toBeGreaterThan(5);
	});

	it("leaves no trigger pointing at a panel that is never rendered", () => {
		const offenders = files.flatMap((f) => {
			const panels = new Set(f.contents);
			return f.triggers
				.filter((v) => !panels.has(v))
				.map((v) => `${f.path}: <TabsTrigger value=${v}> has no matching <TabsContent>`);
		});
		expect(offenders).toEqual([]);
	});
});
