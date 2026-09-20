/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Zustand 5 re-renders a component on every `set()` to a store when the hook
 * is called with no selector, because the whole state object is what it
 * subscribes to (#1714). Three shapes cause this, and this guard scans
 * `app/src` for all three:
 *
 * 1. `useXStore()` - no selector at all, subscribes to the whole state.
 * 2. `useXStore((s) => ({ ... }))` - a selector that returns a fresh object
 *    literal every call, which fails Zustand's `Object.is` check and
 *    re-renders every time regardless of whether the picked fields changed.
 *    `useShallow` from `zustand/react/shallow` fixes this by comparing the
 *    object's own fields instead of its identity, so a selector wrapped in
 *    `useShallow(...)` is fine.
 * 3. A selector whose body calls `.filter(` or `.map(` - it returns a fresh
 *    array every call for the same reason as (2), and no wrapper fixes an
 *    array built fresh each time (a `useShallow` compare still sees new
 *    elements when the source data is unstable) so the derivation belongs in
 *    a `useMemo` downstream of a field selector instead.
 *
 * Sites owned by another in-flight issue are allowlisted below rather than
 * fixed here, each with the issue that retires its entry.
 *
 * Mutation check: reintroduce any selector-less call (for example
 * `useLayoutStore()` in `Drawer.tsx`) and this file's first `it` fails.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `file:line` sites left selector-less on purpose because the file belongs
 * to a sibling issue's fix, not this one. Remove the entry in the same
 * commit that issue lands.
 */
const ALLOWLIST = new Set<string>([
	// #1716 rebuilds VariableTableEditor's rows into a memoised `VariableRow`;
	// narrowing this store read now would be redone by that issue's refactor.
	"modules/variables/main/VariableTableEditor.tsx:290",
	"modules/variables/main/VariableTableEditor.tsx:302",
]);

const scanned = globSync("**/*.{ts,tsx}", { cwd: srcRoot }).filter(
	(file) => !file.includes(".test.") && !file.includes(".testkit.")
);

const NO_SELECTOR = /\buse[A-Z]\w*Store\(\)/;
/** A direct object-literal selector, not one passed through `useShallow`. */
const OBJECT_SELECTOR = /use[A-Z]\w*Store\(\s*(?!useShallow)\(?[^)]*\)?\s*=>\s*\(\{/;
/** A selector whose body derives a fresh array - no wrapper fixes this. */
const DERIVED_ARRAY = /use[A-Z]\w*Store\([^;]*=>[^;]*\.(?:filter|map)\(/;

interface Finding {
	/** Relative to `app/src`, POSIX-spelled. */
	readonly file: string;
	readonly line: number;
	readonly kind: "no-selector" | "object-literal" | "derived-array";
	readonly text: string;
}

function scan(): Finding[] {
	const findings: Finding[] = [];
	for (const file of scanned) {
		const posixFile = file.split("\\").join("/");
		const lines = readFileSync(join(srcRoot, file), "utf8").split(/\r?\n/);
		lines.forEach((line, at) => {
			const site = `${posixFile}:${at + 1}`;
			if (ALLOWLIST.has(site)) return;
			if (NO_SELECTOR.test(line)) {
				findings.push({ file: posixFile, line: at + 1, kind: "no-selector", text: line.trim() });
			} else if (OBJECT_SELECTOR.test(line)) {
				findings.push({
					file: posixFile,
					line: at + 1,
					kind: "object-literal",
					text: line.trim(),
				});
			} else if (DERIVED_ARRAY.test(line)) {
				findings.push({ file: posixFile, line: at + 1, kind: "derived-array", text: line.trim() });
			}
		});
	}
	return findings;
}

describe("store subscriptions", () => {
	it("scans a real, non-empty set of files", () => {
		// A broken glob or a moved `srcRoot` would empty this and every check
		// below would pass for having scanned nothing.
		expect(scanned.length).toBeGreaterThan(100);
	});

	it("selects fields, not whole stores, everywhere outside the allowlist", () => {
		const findings = scan();
		const message = findings
			.map(
				({ file, line, kind, text }) =>
					`${file}:${line} [${kind}] ${text}\n  Fix: select the field(s) this component needs, or wrap an object selector in useShallow from "zustand/react/shallow". If this site belongs to another open issue's refactor, add "${file}:${line}" to the ALLOWLIST above with a comment naming that issue.`
			)
			.join("\n");

		expect(findings, message).toEqual([]);
	});

	it("keeps the allowlist trimmed to sites that still exist", () => {
		// An allowlist entry hides its site from `scan()` by construction, so a
		// line the owning issue already narrowed would pass silently forever.
		// This re-reads each entry's exact source line instead, and fails once
		// it no longer holds a bare Store() call worth hiding.
		for (const site of ALLOWLIST) {
			const [file, lineStr] = site.split(":");
			const lines = readFileSync(join(srcRoot, file), "utf8").split(/\r?\n/);
			const text = lines[Number(lineStr) - 1] ?? "";
			expect(text, `${site} is allowlisted but no longer holds a Store() call - remove it`).toMatch(
				/Store\(/
			);
		}
	});
});
