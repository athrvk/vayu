/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Font sizes come from the scale, not from nudging a number until it looks right.
 *
 * The app had **182 arbitrary sizes across 11 distinct values**, and the damage
 * was not the count - it was that half of them duplicated a step that already
 * existed. `text-[12px]` is exactly `text-xs` and `text-[13px]` is exactly
 * `text-sm` (`--text-sm` is redefined to 13px in `index.css`), so those 52 call
 * sites rendered at the documented size while **skipping its paired
 * line-height**: 34 of 36 and 13 of 16 set no `leading-*`, so they inherited
 * whatever the parent had while the 157 `text-sm` siblings got 18px. Same size,
 * different rhythm, for no reason anyone chose.
 *
 * Seven were half-pixel - `text-[10.5px]`, `text-[11.5px]` - which no scale
 * contains and which render soft on a non-retina display. Those are the
 * signature of adjusting by eye.
 *
 * `text-[10px]` and `text-[11px]` stay allowed: both are in the documented table
 * as the micro/badge and eyebrow sizes, and a dense developer tool genuinely
 * needs steps below 12px. They are permitted *by name* here rather than by
 * pattern, so a twelfth value cannot arrive unnoticed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";

// This file sits in `src/components/ui`, so `src/` is two levels up.
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The arbitrary sizes that are part of the scale, per
 * `docs/design-system.md` -> Type Scale Conventions. Everything else must use a
 * named utility so it carries a line-height.
 */
const ALLOWED_ARBITRARY = new Set([
	"text-[10px]", // micro / badge
	"text-[11px]", // section label / eyebrow
	"text-[22px]", // secondary metric value
	"text-[34px]", // hero metric value
]);

const files = globSync("**/*.{ts,tsx}", { cwd: srcRoot }).filter((f) => !f.includes(".test."));

describe("type scale", () => {
	it("scans a real set of files", () => {
		// A guard that matches nothing passes silently and reads as coverage.
		expect(files.length).toBeGreaterThan(150);
	});

	it("uses no font size outside the scale", () => {
		const offences: string[] = [];

		for (const file of files) {
			const source = readFileSync(join(srcRoot, file), "utf8");
			source.split("\n").forEach((line, i) => {
				for (const m of line.matchAll(/text-\[[\d.]+px\]/g)) {
					if (ALLOWED_ARBITRARY.has(m[0])) continue;
					offences.push(
						`${relative(".", file)}:${i + 1}  ${m[0]} is not on the scale. ` +
							`Use text-xs (12), text-sm (13), text-md (15), text-base (16), ` +
							`or one of ${[...ALLOWED_ARBITRARY].join(", ")}.`
					);
				}
			});
		}

		expect(offences.join("\n")).toBe("");
	});

	it("has no half-pixel size anywhere", () => {
		// Called out separately because it is the clearest signal of a value
		// arrived at by eye, and it renders soft on a non-retina display.
		const half: string[] = [];
		for (const file of files) {
			const source = readFileSync(join(srcRoot, file), "utf8");
			for (const m of source.matchAll(/text-\[\d+\.\d+px\]/g)) {
				half.push(`${relative(".", file)}  ${m[0]}`);
			}
		}
		expect(half.join("\n")).toBe("");
	});
});

/**
 * The weight half of the same table, which nothing checked until #1199.
 *
 * `docs/design-system.md` said the micro/badge step was `font-mono font-bold`
 * and the primitive that owns the step - `MethodBadge` - had always rendered
 * `font-semibold`, so the row was a claim about a component that did not match
 * it. Four other chips had copied the documented bold.
 *
 * Semibold is what the code font can actually render: `fonts.css` bundles
 * JetBrains Mono - the default `--font-mono` - at 400/500/600, and only Space
 * Mono of the four selectable code faces at 700. So `font-mono font-bold` is a
 * *synthesised* face for everyone who has not picked that one, which is the
 * same reason the fonts note in the doc gives. The size guard above would not
 * have caught any of it, because every one of those chips was on the scale.
 *
 * The rule this enforces is a ceiling, not a single value: a weight *above* 600
 * cannot render, while `font-medium` on a numeric readout is a real face and a
 * deliberate emphasis (`TimingWaterfall`, `PhasePercentiles`).
 *
 * The step has a second row now (#1222). #1199 settled the mono half and left
 * the same size in the UI face with no row to read, so its chips picked a weight
 * each - four across five sites, one pair inside `VariableScopeBadge` itself.
 * Both rows say semibold and the scan below covers both faces: above 600 is a
 * synthesised face in mono, and at 10px in the UI face it closes the counters.
 */
const MICRO_SIZES = ["text-[10px]", "text-[11px]"] as const;
const MICRO_WEIGHT = "font-semibold";

/** Any Tailwind weight utility, `semibold` first so it wins over `bold`. */
const WEIGHT_CLASS = /font-(semibold|extrabold|bold|medium|normal|light|thin|black)\b/;

/** The weights above 600, which no code face but Space Mono can draw. */
const HEAVIER_THAN_SEMIBOLD = new Set(["font-bold", "font-extrabold", "font-black"]);

describe("the micro/badge step's weight", () => {
	const docPath = fromRepoRoot(DOC_READING_GUARDS.typeScale.paths[0]);
	const doc = readFileSync(docPath, "utf8");

	/**
	 * The Type Scale Conventions table, as `| Use | Size | Weight | Class |`
	 * rows. Parsed rather than grepped so a row that moves is still found, and
	 * so the count below is a real proof the table was located.
	 */
	const rows = doc
		.slice(doc.indexOf("### Type Scale Conventions"))
		.split("\n")
		.filter((line) => line.startsWith("|") && !/^\|[-|\s]+\|$/.test(line))
		.map((line) =>
			line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim())
		)
		.filter((cells) => cells.length === 4 && cells[0] !== "Use");

	it("read the table", () => {
		// The scan this whole block rests on: a heading that moved, or a table
		// rewritten into another shape, must fail here rather than pass by
		// matching nothing.
		expect(doc.length).toBeGreaterThan(1000);
		expect(rows.length).toBeGreaterThanOrEqual(8);
	});

	// One row per face. Both are asserted, because a contributor reads whichever
	// one matches the chip in front of them and a row that disagreed with its
	// twin would be the same defect the two rows exist to end.
	it.each([
		["Micro / badge (mono)", true],
		["Micro / badge (UI face)", false],
	])("%s is documented as the weight the app renders", (use, isMono) => {
		const micro = rows.find((cells) => cells[0] === use);
		expect(micro, `no '${use}' row in the Type Scale Conventions table`).toBeDefined();
		const [, , weight, klass] = micro as string[];

		// Both cells, because they drifted as a pair: the Weight cell is what a
		// contributor reads and the Class cell is what they paste. `semibold`
		// leads the alternation so it is not read as the `bold` inside it.
		expect(/\b(semibold|extrabold|bold|medium|regular|normal|light)\b/.exec(weight)?.[1]).toBe(
			"semibold"
		);
		expect(klass).toContain(MICRO_WEIGHT);
		// The class cell is the thing a contributor pastes, so the row that is not
		// about mono must not hand them a `font-mono` to paste with it.
		expect(klass.includes("font-mono")).toBe(isMono);
	});
});

describe("no chip at the micro/badge step is heavier than the step", () => {
	/**
	 * Every class string carrying a 10-11px size, in either face. A weight named
	 * there must not be above the step's; a string that names no weight is fine -
	 * it is either inheriting `Badge`'s own `font-semibold` or printing a value,
	 * which the URL/path step leaves unweighted.
	 *
	 * This sees a class only where it is written as a literal beside the size.
	 * `MethodBadge` and `VariableScopeBadge` compose the two through `cn()` in
	 * separate arguments - or take the weight from a `cva` base, which is not in
	 * the source at all - so the step's primitives are pinned by rendering them
	 * (`MethodBadge.test.tsx`, `variable-scope-badge.test.tsx`), not here.
	 */
	const found: { where: string; mono: boolean }[] = [];
	const offences: string[] = [];

	for (const file of files) {
		const source = readFileSync(join(srcRoot, file), "utf8");
		for (const [literal] of source.matchAll(/"[^"\n]*"/g)) {
			if (!MICRO_SIZES.some((size) => literal.includes(size))) continue;
			const mono = literal.includes("font-mono");
			found.push({ where: `${relative(".", file)}  ${literal}`, mono });
			const weight = WEIGHT_CLASS.exec(literal)?.[0];
			if (weight === undefined || !HEAVIER_THAN_SEMIBOLD.has(weight)) continue;
			offences.push(
				`${relative(".", file)}  ${literal}\n  ` +
					`${weight} at the micro/badge step ` +
					(mono
						? "is a synthesised face - the default code font ships no weight above 600."
						: "closes the counters at this size rather than reading as emphasis.") +
					` Use ${MICRO_WEIGHT}.`
			);
		}
	}

	// Both faces, separately: the scan grew to cover the UI face in #1222, and a
	// regex that quietly stopped matching one of them would still pass a count
	// carried by the other.
	it("scans a real set of chips in the code face", () => {
		expect(found.filter((chip) => chip.mono).length).toBeGreaterThan(3);
	});

	it("scans a real set of chips in the UI face", () => {
		expect(found.filter((chip) => !chip.mono).length).toBeGreaterThan(3);
	});

	it("uses no weight above the step", () => {
		expect(offences.join("\n")).toBe("");
	});
});

describe("the scale steps carry paired line-heights", () => {
	/**
	 * A size without a line-height inherits the parent's, which is how the same
	 * size ended up with two different rhythms. Every step redefined in `@theme`
	 * must declare both.
	 */
	const css = readFileSync(join(srcRoot, "index.css"), "utf8");

	it("read the stylesheet", () => {
		expect(css.length).toBeGreaterThan(1000);
	});

	it.each(["sm", "md"])("--text-%s declares a line-height", (step) => {
		expect(css).toContain(`--text-${step}:`);
		expect(css).toContain(`--text-${step}--line-height:`);
	});
});
