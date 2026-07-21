/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `docs/design-system.md` quotes real token values. They have to still be real.
 *
 * The doc opens with "future sessions must read this before touching any UI
 * file", which makes a stale value worse than no value — it is read as
 * authoritative and copied. Nothing connected the two files, so they drifted:
 * the accent table listed `sunset` as `24.6 95% 53.1%` where the CSS had
 * `24 90% 46%`, named a default that had since changed, and quoted
 * `--muted-foreground` at 44% two points after the CSS moved to 42%.
 *
 * This checks the values only. Prose, ratios and rationale still need a human —
 * a number here being right does not make the sentence around it right.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "index.css"), "utf8");
const doc = readFileSync(join(here, "..", "..", "docs", "design-system.md"), "utf8");

/** Every declared value for a token, anywhere in the stylesheet. */
function declaredValues(): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const m of css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
		const value = m[2].split(/\s+/).join(" ").trim();
		if (!out.has(m[1])) out.set(m[1], new Set());
		out.get(m[1])!.add(value);
	}
	return out;
}

// The doc aligns values in columns, so `240  4% 42%` has runs of spaces. An
// earlier version of this scan required single spaces and silently matched
// nothing on exactly the lines that had drifted.
const QUOTED = /--([a-z0-9-]+):\s*([\d.]+\s+[\d.]+%\s+[\d.]+%)/g;

describe("design-system.md token values", () => {
	const declared = declaredValues();

	it("reads both files", () => {
		expect(css.length).toBeGreaterThan(1000);
		expect(doc.length).toBeGreaterThan(1000);
		expect(declared.size).toBeGreaterThan(40);
	});

	it("finds a meaningful number of quoted values", () => {
		expect([...doc.matchAll(QUOTED)].length).toBeGreaterThan(30);
	});

	it("quotes only values that index.css actually declares", () => {
		const stale: string[] = [];
		const lines = doc.split(/\r?\n/);

		lines.forEach((line, i) => {
			for (const m of line.matchAll(QUOTED)) {
				const token = m[1];
				const quoted = m[2].split(/\s+/).join(" ");
				const values = declared.get(token);
				if (!values) {
					stale.push(
						`design-system.md:${i + 1}  --${token} is not declared in index.css`
					);
				} else if (!values.has(quoted)) {
					stale.push(
						`design-system.md:${i + 1}  --${token}: doc says "${quoted}", index.css has ${[
							...values,
						]
							.map((v) => `"${v}"`)
							.join(" / ")}`
					);
				}
			}
		});

		expect(stale.join("\n")).toBe("");
	});

	it("keeps the accent-scheme table in step with the stylesheet", () => {
		// Three columns: light --primary, dark --primary, dark --primary-fill.
		const block = (scheme: string, dark: boolean) =>
			new RegExp(
				`^\\t${dark ? "\\.dark" : ""}\\[data-color-scheme="${scheme}"\\] \\{([\\s\\S]*?)\\n\\t\\}`,
				"m"
			).exec(css)?.[1] ?? "";
		const token = (body: string, name: string) =>
			new RegExp(`--${name}:\\s*([^;]+);`).exec(body)?.[1].trim();

		const rows = [
			...doc.matchAll(/^\| `([a-z]+)` \| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|$/gm),
		];
		expect(rows.length, "no accent rows found — has the table moved?").toBeGreaterThanOrEqual(
			6
		);

		for (const [, scheme, light, darkPrimary, darkFill] of rows) {
			expect([light, darkPrimary, darkFill], `scheme "${scheme}"`).toEqual([
				token(block(scheme, false), "primary"),
				token(block(scheme, true), "primary"),
				token(block(scheme, true), "primary-fill"),
			]);
		}
	});
});
