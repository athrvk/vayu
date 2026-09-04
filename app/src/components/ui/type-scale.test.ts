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
import { join, dirname, relative, sep } from "node:path";
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
	// The two metric sizes left this set in #1409: 34px and 22px are
	// `--text-hero` and `--text-metric` now, which is what carries their paired
	// line-height. Only the badge steps, which have no token, remain arbitrary.
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
							`Use text-xs (12), text-sm (13), text-md (15), ` +
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

	// The named steps, size cell against class cell. The table is what a
	// contributor reads before picking one, and until #1202 nothing checked that
	// the size it states is the size the utility renders.
	it.each([
		["Hero metric value", "34px", "text-hero"],
		["Secondary metric value", "22px", "text-metric"],
		["View title", "20px", "text-xl"],
		["Tile metric value", "18px", "text-lg"],
		["Title / small heading", "15px", "text-md"],
		["Body / default", "13px", "text-sm"],
		["Small label", "12px", "text-xs"],
	])("%s is %s, written as %s", (use, size, klass) => {
		const row = rows.find((cells) => cells[0] === use);
		expect(row, `no '${use}' row in the Type Scale Conventions table`).toBeDefined();
		expect((row as string[])[1]).toBe(size);
		expect((row as string[])[3]).toContain(klass);
	});
});

describe("no chip at the micro/badge step is heavier than the step", () => {
	/**
	 * Every class string carrying a 10-11px size, in either face. A weight named
	 * there must not be above the step's; a string that names no weight is fine -
	 * it is either inheriting `Badge`'s own `font-semibold` or printing a value,
	 * which the URL/path step leaves unweighted.
	 *
	 * Both quoting forms, because a class list with a conditional in it is a
	 * template literal and two of the app's are at this size - a quoted-only
	 * scan reads as covering the app while missing them.
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
		for (const [literal] of source.matchAll(/"[^"\n]*"|`[^`]*`/g)) {
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

	it.each(["sm", "md", "hero", "metric"])("--text-%s declares a line-height", (step) => {
		expect(css).toContain(`--text-${step}:`);
		expect(css).toContain(`--text-${step}--line-height:`);
	});

	// Every step the app defines, pinned to the pixel. Nothing held these values
	// until #1202: the doc guard next door reads colour triples, so `--text-sm`
	// could have become 14px with the page still claiming 13. The two metric
	// steps joined them in #1409, where they stopped being arbitrary values.
	it.each([
		["sm", "0.8125rem", 13],
		["md", "0.9375rem", 15],
		["metric", "1.375rem", 22],
		["hero", "2.125rem", 34],
	])("--text-%s is %s", (step, rem, px) => {
		expect(css).toContain(`--text-${step}: ${rem};`);
		expect(Number(rem.replace("rem", "")) * 16).toBe(px);
	});
});

/**
 * The ceiling the register decision put on chrome (#1202).
 *
 * `CardTitle` named no size of its own, so all 51 card headings in the app
 * named one - 45 at `text-base`, 6 at `text-lg` - and a settings panel heading
 * rendered 16px against 13px body. The primitive owns `text-md` now, and the
 * two sizes above it are gone from the app's chrome: `text-base` entirely, and
 * `text-lg` down to the tile metric readouts, which are bold numbers rather
 * than headings.
 *
 * An allowlist by file rather than by rule, because "a number in a tile" is not
 * something a scan can recognise - and each entry is asserted to still use the
 * step, so a file that stops rendering one drops off the list instead of
 * silently licensing a heading there later.
 */
/**
 * Source with its comments removed, because the rule is about what renders. The
 * prose explaining why `text-base` is gone names `text-base`, and a scan that
 * counted that would make the explanation the violation.
 */
const withoutComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(?<!:)\/\/.*$/gm, " ");

const TILE_READOUTS = [
	"modules/collections/CollectionDetail/shared.tsx",
	"modules/dashboard/components/RequestResponseView.tsx",
	"modules/history/main/components/OverviewTab.tsx",
	"modules/history/main/components/LatencyMetric.tsx",
	// Three run-summary numbers that were 20px until #1409, in the same shape as
	// the four above: a bold number in a muted tile.
	"modules/history/main/LoadTestDetail.tsx",
] as const;

/**
 * The one step above 18px, and the two files that may write it (#1409).
 *
 * A settings view stacks three levels - the view title, its description, and
 * the cards whose `CardTitle` is `text-md` - so the title keeps a step of its
 * own rather than flattening into the headings under it. It cannot be `text-lg`
 * either: that step means "tile metric value" here, and a title reusing it
 * would give one step two meanings.
 */
const VIEW_TITLES = [
	"modules/settings/main/SettingsMain.tsx",
	"modules/settings/main/panels/ClientSettingsPanel.tsx",
] as const;

/** Every named Tailwind step above the view title. None of them is on the scale. */
const ABOVE_THE_SCALE = /\btext-(2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/;

describe("the register above body is held by file", () => {
	const sizes = files.map((file) => ({
		file,
		source: withoutComments(readFileSync(join(srcRoot, file), "utf8")),
	}));

	it("scans a real set of files", () => {
		expect(sizes.length).toBeGreaterThan(150);
	});

	it("writes text-base nowhere", () => {
		const offences = sizes
			.filter(({ source }) => /\btext-base\b/.test(source))
			.map(
				({ file }) =>
					`${relative(".", file)}  text-base (16px) is above the chrome ceiling. ` +
					`A heading is text-md, body is text-sm; CardTitle and DialogTitle ` +
					`carry the step already.`
			);
		expect(offences.join("\n")).toBe("");
	});

	it("writes text-lg only in the tile metric readouts", () => {
		const offences = sizes
			.filter(({ file, source }) => {
				const posix = file.split(sep).join("/");
				return /\btext-lg\b/.test(source) && !TILE_READOUTS.some((r) => posix === r);
			})
			.map(
				({ file }) =>
					`${relative(".", file)}  text-lg (18px) is the tile metric value step, ` +
					`not a heading. Use text-md.`
			);
		expect(offences.join("\n")).toBe("");
	});

	it.each(TILE_READOUTS)("%s still renders a tile metric value", (readout) => {
		const entry = sizes.find(({ file }) => file.split(sep).join("/") === readout);
		expect(entry, `${readout} is allowlisted for text-lg but no longer exists`).toBeDefined();
		expect(entry?.source).toMatch(/\btext-lg\b/);
	});

	it("writes text-xl only in the two view titles", () => {
		const offences = sizes
			.filter(({ file, source }) => {
				const posix = file.split(sep).join("/");
				return /\btext-xl\b/.test(source) && !VIEW_TITLES.some((v) => posix === v);
			})
			.map(
				({ file }) =>
					`${relative(".", file)}  text-xl (20px) is the view title step, one per ` +
					`view. A number in a tile is text-lg; a heading is text-md.`
			);
		expect(offences.join("\n")).toBe("");
	});

	it.each(VIEW_TITLES)("%s still renders a view title", (title) => {
		const entry = sizes.find(({ file }) => file.split(sep).join("/") === title);
		expect(entry, `${title} is allowlisted for text-xl but no longer exists`).toBeDefined();
		expect(entry?.source).toMatch(/\btext-xl\b/);
	});

	it("writes nothing above the view title step", () => {
		// 24px and up have no row in the table and no token behind them. The
		// metric values that reached for `text-2xl` are `text-metric` (22px) now,
		// which is the size the dashboard's own cards were designed at (#1409).
		const offences = sizes
			.filter(({ source }) => ABOVE_THE_SCALE.test(source))
			.map(
				({ file, source }) =>
					`${relative(".", file)}  ${ABOVE_THE_SCALE.exec(source)?.[0]} is off the ` +
					`scale. A metric value is text-metric (22) or text-hero (34).`
			);
		expect(offences.join("\n")).toBe("");
	});

	it("leaves the input primitive one size at every window width", () => {
		// Stock shadcn's `text-base md:text-sm` is the iOS zoom workaround, and a
		// narrow desktop pane is not a phone: below `md` it rendered every input
		// at 16px, the one size the scale does not contain.
		const input = withoutComments(
			readFileSync(join(srcRoot, "components", "ui", "input.tsx"), "utf8")
		);
		expect(input).toContain("text-sm");
		expect(input).not.toMatch(/\bmd:text-/);
	});
});
