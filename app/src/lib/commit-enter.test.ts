/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An Enter that acts is `isCommitEnter`, everywhere but the activation sites.
 *
 * Nothing about a plain `e.key === "Enter"` looks wrong, which is how seven
 * fields came to be missing the guard at once (#939, #935, then #1684): an
 * IME's composition commit reaches the handler as an ordinary keydown, and
 * mod+Enter is the app's Send chord, so an unguarded field acts on a
 * half-composed value and turns one press into two actions.
 *
 * The allowlist is the exception, and it is *keyboard activation of a
 * hand-rolled control* - a `role="button"` or `role="tab"` standing in for a
 * native one, where the rule the platform implements is "Enter or Space
 * activates" and Space is checked on the same line. Those press a control the
 * user is looking at rather than reading a text buffer, so neither an IME nor
 * the Send chord can mean something else there. A new entry is a claim that
 * the site is one of those; a text field is never one.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

/**
 * Paths, relative to `src/`, allowed to compare a key to "Enter" themselves.
 *
 * `keyboard.ts` is the definition every other site reads. The three components
 * activate a hand-rolled control, and `useRovingTreeFocus` is the tree's own
 * row activation - it bails on Ctrl/Cmd before the switch it does this in.
 */
const ALLOWED = [
	"lib/keyboard.ts",
	"components/ui/variable-popover.tsx",
	"components/ui/markdown-editor.tsx",
	"components/layout/TabStrip.tsx",
	"modules/collections/useRovingTreeFocus.ts",
];

const BARE_ENTER = /\.key\s*===\s*["']Enter["']/;

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return walk(full);
		return /\.tsx?$/.test(entry) ? [full] : [];
	});
}

/** Comment lines mention the rule constantly; only code counts. */
function codeLines(source: string): string[] {
	return source
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(line) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*")
		);
}

const files = walk(srcRoot).filter((f) => !/\.test\.tsx?$|\.testkit\.ts$/.test(f));

describe("an Enter that acts goes through isCommitEnter", () => {
	it("scanned a non-empty tree", () => {
		// A guard that reads nothing passes forever.
		expect(files.length).toBeGreaterThan(100);
		expect(files.some((f) => f.endsWith(join("lib", "keyboard.ts")))).toBe(true);
	});

	it("names every site that compares a key to Enter itself", () => {
		const offenders = files
			.filter((f) => codeLines(readFileSync(f, "utf8")).some((l) => BARE_ENTER.test(l)))
			.map((f) => relative(srcRoot, f).split("\\").join("/"))
			.filter((f) => !ALLOWED.includes(f));

		expect(offenders).toEqual([]);
	});

	it("keeps the allowlist honest: every entry still holds such a comparison", () => {
		const stale = ALLOWED.filter(
			(entry) =>
				!codeLines(readFileSync(join(srcRoot, entry), "utf8")).some((l) =>
					BARE_ENTER.test(l)
				)
		);

		expect(stale).toEqual([]);
	});

	it("no allowlisted site is a text field's onKeyDown", () => {
		// The allowlist is for activating a hand-rolled control. A field that
		// reads a buffer - an `<Input>`, `<input>` or `<textarea>` - is the case
		// the rule exists for, so one appearing in an allowlisted file with a
		// bare Enter beside it would be the defect slipping back in under cover.
		const withFields = ALLOWED.filter((entry) => {
			const lines = codeLines(readFileSync(join(srcRoot, entry), "utf8"));
			return lines.some(
				(line, i) =>
					BARE_ENTER.test(line) &&
					lines
						.slice(Math.max(0, i - 12), i)
						.some((above) => /<(Input|input|textarea)\b/.test(above))
			);
		});

		expect(withFields).toEqual([]);
	});
});
