/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A tooltip's value never shares a flex row with a label that refuses to shrink
 * (issue #1195).
 *
 * `TooltipContent` is capped at `max-w-xs`. A value carrying `break-all` has a
 * min-content width of about one character, so it is the only item flexbox can
 * take width from; a `shrink-0` sibling keeps its own intrinsic width whatever
 * it holds. Put the two in one row and a long source name - an environment with
 * a descriptive title, a declared column list - takes the whole 320px and
 * leaves the value a vertical strip of five-letter fragments. The value is the
 * thing the tooltip exists to show.
 *
 * Fixing the two components that had this shape does not fix the app: the next
 * hand-written tooltip can reach for the same row exactly as they did. So the
 * rule is made **enumerable rather than impossible**, the way the border and
 * tooltip-contrast rules are - the mistake is one shape and every tooltip block
 * in `src` is read. `TooltipValue` is the cure: it stacks the pair, so a call
 * site that uses it cannot express the defect.
 *
 * This scan sees only literal class strings. The rendered-class assertions in
 * `VariableInput/EditableVariable.test.tsx` and
 * `VariableInput/runtime-token-interaction.test.tsx` cover the other half.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tsxFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsxFiles(full));
		else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) out.push(full);
	}
	return out;
}

/** `<TooltipContent …>…</TooltipContent>`, comments stripped so prose about the
 *  rule does not read as a violation of it. */
const TOOLTIP_BLOCK = /<TooltipContent\b[^>]*>[\s\S]*?<\/TooltipContent>/g;

const blocks = tsxFiles(SRC).flatMap((file) =>
	[
		...readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.matchAll(TOOLTIP_BLOCK),
	].map((m) => ({ file, source: m[0] }))
);

describe("every tooltip that prints a value", () => {
	it("found the tooltips to scan", () => {
		// A regex that stopped matching would make the case below vacuous - this
		// repo has had a guard pass for weeks while reading an empty string.
		expect(blocks.length).toBeGreaterThan(12);
	});

	it("puts no unshrinkable label beside a value that wraps on any character", () => {
		const offenders = blocks
			.filter((b) => b.source.includes("break-all") && b.source.includes("shrink-0"))
			.map((b) => b.file);
		expect(offenders).toEqual([]);
	});
});
