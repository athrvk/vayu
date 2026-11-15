/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An element that renders text never paints a translucent accent behind it
 * (#3515).
 *
 * `bg-primary/10` is an alpha of `--primary`, which brightens in dark and is a
 * neutral on graphite, so the ground it composites to is whatever the card
 * underneath and the scheme make it. `--primary-text` on it measured 3.0-4.4:1
 * on three schemes while the label looked fine on the default one. The opaque
 * `--primary-tint` / `--primary-tint-hover` / `--primary-fill-hover` tokens are
 * held to a ratio per scheme and theme in `constants/color-scheme-contrast.test.ts`;
 * an alpha cannot be, so it is only allowed where no text sits on it (a dot, a
 * ring, a text-selection highlight).
 *
 * The scan reads the code with comments blanked and flags a `bg-primary/<n>`
 * or `bg-primary-fill/<n>` under any variant prefix (`hover:`, `disabled:`,
 * `data-[active=true]:`). It cannot see a class that arrives in a variable;
 * that is the limit of every source scan here (`app/CLAUDE.md`).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "@/lib/strip-comments.testkit";

const srcRoot = dirname(fileURLToPath(import.meta.url));

/** `bg-primary` or `bg-primary-fill` with a `/<alpha>`, not preceded by a class-name character. */
const ACCENT_ALPHA = /(?<![\w-])bg-primary(?:-fill)?\/(?:\d+|\[[^\]\s]+\])/g;

/** Every translucent accent background in a source file's code, with its line. */
function accentAlphas(source: string): { line: number; match: string }[] {
	const hits: { line: number; match: string }[] = [];
	stripComments(source)
		.split("\n")
		.forEach((text, index) => {
			for (const [match] of text.matchAll(ACCENT_ALPHA)) {
				hits.push({ line: index + 1, match });
			}
		});
	return hits;
}

/** A use that is allowed because nothing under the element renders text. */
const TEXT_FREE: { file: string; reason: string }[] = [
	{
		file: "components/shared/VariableInput/index.tsx",
		reason: "selection highlight over a `text-transparent` input; the visible text is the overlay, so no label rests on this ground",
	},
];

const sourceFiles = globSync("**/*.{ts,tsx}", { cwd: srcRoot })
	.filter((file) => !/\.(test|testkit)\./.test(file))
	.map((file) => file.split("\\").join("/"));

const hitsByFile = new Map(
	sourceFiles
		.map((file) => [file, accentAlphas(readFileSync(join(srcRoot, file), "utf8"))] as const)
		.filter(([, hits]) => hits.length > 0)
);

describe("no translucent accent background under text", () => {
	it("scanned the source tree", () => {
		expect(sourceFiles.length).toBeGreaterThan(100);
	});

	it("finds a file only when it carries an accent alpha outside the text-free list", () => {
		const allowed = new Set(TEXT_FREE.map((entry) => entry.file));
		const offenders = [...hitsByFile]
			.filter(([file]) => !allowed.has(file))
			.flatMap(([file, hits]) => hits.map((hit) => `${file}:${hit.line} ${hit.match}`));
		expect(
			offenders,
			"use bg-primary-tint / hover:bg-primary-tint-hover (or bg-primary-fill-hover) where text sits on the ground"
		).toEqual([]);
	});

	it.each(TEXT_FREE)("still needs its allow-list entry: $file", ({ file }) => {
		expect(hitsByFile.has(file), `${file} no longer has an accent alpha; drop the entry`).toBe(
			true
		);
	});

	it("catches an alpha under every variant prefix", () => {
		const planted = [
			'const a = "bg-primary/10";',
			'const b = "hover:bg-primary/20";',
			'const c = "disabled:hover:bg-primary-fill/10";',
			'const d = "data-[active=true]:bg-primary/15";',
			'const e = "selection:bg-primary/[0.3]";',
		].join("\n");
		expect(accentAlphas(planted).map((hit) => hit.match)).toEqual([
			"bg-primary/10",
			"bg-primary/20",
			"bg-primary-fill/10",
			"bg-primary/15",
			"bg-primary/[0.3]",
		]);
		expect(accentAlphas(planted).map((hit) => hit.line)).toEqual([1, 2, 3, 4, 5]);
	});

	it("leaves the opaque tokens, borders, rings and comments alone", () => {
		const clean = [
			'const a = "bg-primary-tint hover:bg-primary-tint-hover bg-primary-fill hover:bg-primary-fill-hover";',
			'const b = "border-primary/30 ring-primary/20 text-primary/70";',
			"// was bg-primary/10",
			"/* hover:bg-primary/20 */",
		].join("\n");
		expect(accentAlphas(clean)).toEqual([]);
	});
});
