/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A control wired to an empty function is a dead control.
 *
 * `ResponseViewer` shipped two: a "Load Test" button in the response header and
 * a "View Load Test Dashboard" button in the empty state, both calling
 *
 *     const handleViewLoadTest = () => {
 *         // View dashboard: would require navigating to dashboard tab
 *         // This is handled by dashboardMode being "running" which shows the button
 *     };
 *
 * The comment is the tell. It explains why the button *appears* and says nothing
 * about what clicking it does - someone reached the navigation problem, wrote
 * down the gap, and left. Clicking did nothing, and `currentRunId` is never
 * cleared, so both buttons were permanent after the session's first load test.
 *
 * A no-op handler is invisible to type checking, to lint, and to any test that
 * does not click the thing. This is the cheapest place to catch it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `const foo = (...) => {` - the head only. The body is scanned separately. */
const ARROW_HEAD = /const\s+(\w+)\s*=\s*\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*\{/g;

/**
 * Is the body opening at `openIndex` empty - nothing but whitespace and
 * comments before its closing brace?
 *
 * **It walks forward instead of matching the whole body**, and both of the
 * obvious alternatives were tried and are wrong here:
 *
 * A single regex for `{ comments only }` was the original, and it had a false
 * positive that surfaced the first time a real handler opened with a block
 * comment: `[\s\S]*?` backtracks past that comment's own terminator and pairs
 * with a **later** one - in practice a JSX comment further
 * down the file, whose terminator is immediately followed by a closing
 * brace. It reported a
 * 4,900-character function as empty.
 *
 * Brace counting was the next attempt, and it is worse in this codebase: a
 * scanner that does not parse strings breaks on `includes("{{")`, and `{{var}}`
 * literals are everywhere. It called two working handlers empty.
 *
 * The question is only ever "is the first thing in this body a `}`", which
 * needs no knowledge of where the body ends. A guard that reports a defect that
 * is not there gets switched off, so it is worth being exact about the small
 * question rather than approximate about the large one.
 */
function hasEmptyBody(source: string, openIndex: number): boolean {
	let i = openIndex + 1;
	for (;;) {
		while (i < source.length && /\s/.test(source[i])) i++;
		if (source.startsWith("//", i)) {
			const nl = source.indexOf("\n", i);
			if (nl === -1) return true;
			i = nl + 1;
			continue;
		}
		if (source.startsWith("/*", i)) {
			const end = source.indexOf("*/", i + 2);
			if (end === -1) return true;
			i = end + 2;
			continue;
		}
		return source[i] === "}";
	}
}

/**
 * `onClick={foo}`, `onSelect={foo}` - any handler prop bound to this name.
 *
 * `String.raw`, deliberately. Written first as a plain template literal with
 * `\\w`, which collapsed to `\w` in the file and then to a bare `w` when the
 * template was evaluated - the pattern became `on[A-Z]w*=…` and matched
 * nothing. The guard passed against its own mutation until that was chased
 * down, which is the only reason it is written this way.
 */
const wiredTo = (name: string) => new RegExp(String.raw`on[A-Z]\w*=\{${name}\}`);

describe("no dead click handlers", () => {
	it("scans a real set of components", () => {
		expect(globSync("**/*.tsx", { cwd: srcRoot }).length).toBeGreaterThan(100);
	});

	/** Every empty-bodied arrow in a source, by name. */
	function emptyHandlers(source: string): Array<{ name: string; index: number }> {
		const found: Array<{ name: string; index: number }> = [];
		for (const m of source.matchAll(ARROW_HEAD)) {
			const open = m.index + m[0].length - 1;
			if (hasEmptyBody(source, open)) {
				found.push({ name: m[1], index: m.index });
			}
		}
		return found;
	}

	it("matches the shape it is looking for (guards the regexes themselves)", () => {
		const sample = "const handleThing = () => {\n\t// gap\n};";
		expect(emptyHandlers(sample).map((h) => h.name)).toEqual(["handleThing"]);
		expect(wiredTo("handleThing").test("onClick={handleThing}")).toBe(true);
		expect(wiredTo("handleThing").test("onClick={handleOther}")).toBe(false);
	});

	it("does not call a handler empty because it opens with a block comment", () => {
		/*
		 * The false positive this guard shipped with. A block comment above real
		 * code let the old regex backtrack past its own terminator and pair with
		 * a JSX comment further down, whose terminator is followed by a brace -
		 * so a working handler was reported as empty.
		 */
		const sample = [
			"const handleKeyDown = (e: KeyboardEvent) => {",
			"\t/*",
			"\t * Why this does what it does.",
			"\t */",
			"\tif (e.key === 'Escape') return;",
			"};",
			"return <div>{/* Input layer */}</div>;",
		].join("\n");
		expect(emptyHandlers(sample)).toEqual([]);
	});

	it("still catches a handler whose body is only a comment", () => {
		const sample = [
			"const handleViewLoadTest = () => {",
			"\t// View dashboard: would require navigating to dashboard tab",
			"};",
			"return <button onClick={handleViewLoadTest} />;",
		].join("\n");
		expect(emptyHandlers(sample).map((h) => h.name)).toEqual(["handleViewLoadTest"]);
	});

	it("has no handler that is passed to a control and does nothing", () => {
		const offences: string[] = [];

		for (const file of globSync("**/*.tsx", { cwd: srcRoot })) {
			if (file.includes(".test.")) continue;
			const source = readFileSync(join(srcRoot, file), "utf8");

			for (const { name, index } of emptyHandlers(source)) {
				// Only a problem if something actually wires it to an interaction.
				// An empty function passed as a required-but-unused prop, or a
				// deliberate no-op default, is not a dead *control*.
				if (wiredTo(name).test(source)) {
					const line = source.slice(0, index).split("\n").length;
					offences.push(
						`${relative(".", file)}:${line}  ${name} is empty but wired to a control`
					);
				}
			}
		}

		expect(offences.join("\n")).toBe("");
	});
});
