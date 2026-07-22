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

/**
 * `const foo = () => {};` - allowing whitespace and comments inside the body,
 * since a comment is exactly what made the original look intentional.
 */
const EMPTY_ARROW =
	/const\s+(\w+)\s*=\s*\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*\{\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*\}/g;

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

	it("matches the shape it is looking for (guards the regexes themselves)", () => {
		const sample = "const handleThing = () => {\n\t// gap\n};";
		expect([...sample.matchAll(EMPTY_ARROW)].map((m) => m[1])).toEqual(["handleThing"]);
		expect(wiredTo("handleThing").test("onClick={handleThing}")).toBe(true);
		expect(wiredTo("handleThing").test("onClick={handleOther}")).toBe(false);
	});

	it("has no handler that is passed to a control and does nothing", () => {
		const offences: string[] = [];

		for (const file of globSync("**/*.tsx", { cwd: srcRoot })) {
			if (file.includes(".test.")) continue;
			const source = readFileSync(join(srcRoot, file), "utf8");

			for (const match of source.matchAll(EMPTY_ARROW)) {
				const name = match[1];
				// Only a problem if something actually wires it to an interaction.
				// An empty function passed as a required-but-unused prop, or a
				// deliberate no-op default, is not a dead *control*.
				if (wiredTo(name).test(source)) {
					const line = source.slice(0, match.index).split("\n").length;
					offences.push(
						`${relative(".", file)}:${line}  ${name} is empty but wired to a control`
					);
				}
			}
		}

		expect(offences.join("\n")).toBe("");
	});
});
