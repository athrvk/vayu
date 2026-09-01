/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every `<TooltipContent>…</TooltipContent>` written in `src`, for the guards
 * that read them.
 *
 * Two rules are enumerable rather than impossible - a canvas-tuned foreground
 * on the tooltip's fill (`tooltip-hint-contrast.test.ts`) and a value sharing a
 * flex row with a label that will not shrink (`tooltip-value-layout.test.ts`) -
 * and both need the same walk. The second guard began as a copy of the first's
 * helpers, which is the shape the repo has been bitten by often enough to have
 * a rule about it: widening the block regex to catch a spelling it misses, or
 * changing which directories are skipped, has to reach both scans.
 *
 * A scan cannot see a class that arrives in a variable, which is why each rule
 * also has a rendered-class guard. The two catch different halves and neither
 * is sufficient.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** `app/src` - this file lives in `src/components/ui`. */
export const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

/** `<TooltipContent …>…</TooltipContent>`, comments stripped so prose about a
 *  rule does not read as a violation of it. */
const TOOLTIP_BLOCK = /<TooltipContent\b[^>]*>[\s\S]*?<\/TooltipContent>/g;

export interface TooltipBlock {
	/** Absolute path of the component the block was read from. */
	file: string;
	/** The block's source, comments removed. */
	source: string;
}

/** Read once: both guards walk the same tree over the same regex. */
export const tooltipBlocks: TooltipBlock[] = tsxFiles(SRC).flatMap((file) =>
	[
		...readFileSync(file, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.matchAll(TOOLTIP_BLOCK),
	].map((m) => ({ file, source: m[0] }))
);
