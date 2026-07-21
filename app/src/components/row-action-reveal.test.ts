/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A control revealed on hover must also be revealed on focus.
 *
 * `docs/design-system.md` has said so for a while — "the `focus-within` half is
 * not optional" — and the variables table's "mark as secret" toggle did not
 * follow it: `opacity-0 group-hover:opacity-100` with no focus counterpart, so
 * a keyboard user tabbed onto an invisible control.
 *
 * The scan is windowed rather than per-line. Class strings here are wrapped by
 * prettier and split across `cn()` arguments, so the reveal and its focus
 * counterpart routinely sit on different lines — a per-line check reported two
 * false positives the first time it ran.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** How far from the hover class a focus counterpart may sit. */
const WINDOW = 8;

const REVEALS_ON_FOCUS = /(group-focus-within:opacity-100|focus-visible:opacity-100)/;

/**
 * Deliberately unreachable by Tab, so a focus reveal is meaningless. The tab
 * strip's close button is `tabIndex={-1}` on purpose — Delete on the focused
 * tab is its keyboard path, and making it a second stop per tab would undo the
 * roving-tabindex win.
 */
const EXEMPT = new Set(["components/layout/TabStrip.tsx"]);

describe("hover-revealed controls", () => {
	it("scans a real set of components", () => {
		const files = globSync("**/*.tsx", { cwd: srcRoot });
		expect(files.length).toBeGreaterThan(100);
	});

	it("are revealed on focus too", () => {
		const offences: string[] = [];

		for (const file of globSync("**/*.tsx", { cwd: srcRoot })) {
			if (EXEMPT.has(file.split("\\").join("/")) || file.includes(".test.")) continue;

			const source = readFileSync(join(srcRoot, file), "utf8");
			// Blank comment bodies, keeping newlines so line numbers stay honest.
			// Several of these files explain the rule in prose and name the very
			// class this looks for — without stripping, a comment satisfies the
			// scan and the real class can be deleted unnoticed.
			const lines = source
				.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
				.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
				.split(/\r?\n/);
			const raw = source.split(/\r?\n/);

			lines.forEach((line, i) => {
				if (!line.includes("group-hover:opacity-100")) return;
				const window = lines.slice(Math.max(0, i - WINDOW), i + WINDOW + 1).join("\n");
				if (!REVEALS_ON_FOCUS.test(window)) {
					offences.push(
						`${relative(".", file)}:${i + 1} reveals on hover with no focus counterpart\n    ${raw[i].trim()}`
					);
				}
			});
		}

		expect(offences.join("\n")).toBe("");
	});
});
