/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The type register is a measurement, and this is where it is measured.
 *
 * "Vayu reads larger than Postman and VS Code" (#1202) is a claim about
 * *perceived* size, which follows x-height rather than the nominal `font-size`
 * - and the six bundled faces differ by 13% in x-height at the same size. So
 * the register decision rests on numbers read out of the font files here rather
 * than remembered: the default UI face is *smaller* than a system face at the
 * documented 13px body step, which is why that token did not move, and the
 * default code face is the largest of the six, which is why the editor default
 * did.
 *
 * Reading the files rather than trusting the table is the point. Swap a
 * `@fontsource` package for a release whose face reads a step larger and every
 * assertion below moves with it - the guard the doc table alone cannot be.
 *
 * The `.woff` sibling of each shipped `.woff2` is what gets parsed: WOFF1 is
 * per-table zlib, which `node:zlib` opens, where WOFF2 needs a Brotli-compressed
 * transformed `glyf` reader. The two files hold the same face and the same
 * `head`/`OS/2` tables - `fonts-woff2-only.test.ts` covers which of them the
 * build actually ships.
 */

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import { DOC_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT, MONO_FONTS, UI_FONTS } from "./appearance";
import { DEFAULT_EDITOR_FONT_SIZE } from "./client-settings";

/**
 * The x-height a system UI face renders at a given size, as the reference the
 * UI register is judged against: Segoe UI's published ratio is 0.50, and it is
 * what a Windows user reads Postman and VS Code's chrome in. Not bundled, so it
 * cannot be measured here - it is a constant on purpose.
 */
const SYSTEM_FACE_RATIO = 0.5;

/**
 * The x-height that reference face renders at 13px, and the ceiling the app's
 * body step is held to: 6.50px is the register a Windows user reads Postman's
 * and VS Code's chrome in. A ceiling in *pixels*, not a ratio comparison - the
 * question is how large the text reads, so a bigger step and a bigger face fail
 * it the same way.
 */
const REFERENCE_BODY_XHEIGHT = SYSTEM_FACE_RATIO * 13;

/**
 * The band a code editor's default lands in: Menlo and Consolas at the sizes
 * VS Code ships them render an x-height of roughly 6.3 to 6.6px. The default
 * code face at the default editor size has to sit inside it, which is the whole
 * content of the 13px -> 12px move.
 */
const EDITOR_XHEIGHT_BAND = { min: 5.5, max: 6.6 } as const;

/** The head of a stack, when that head is a bundled family. */
const promisedFace = (stack: string): string | undefined => /^\s*"([^"]+)"/.exec(stack)?.[1];

/** `"IBM Plex Mono"` -> `ibm-plex-mono`, the `@fontsource` package for it. */
const fontsourcePackage = (family: string): string => family.toLowerCase().replace(/\s+/g, "-");

/** The sfnt tables of a WOFF1 file, decompressed. */
function woffTables(file: Buffer): Map<string, Buffer> {
	if (file.toString("latin1", 0, 4) !== "wOFF") throw new Error("not a WOFF1 file");
	const tables = new Map<string, Buffer>();
	const count = file.readUInt16BE(12);
	for (let i = 0; i < count; i++) {
		const entry = 44 + i * 20;
		const tag = file.toString("latin1", entry, entry + 4);
		const offset = file.readUInt32BE(entry + 4);
		const compressed = file.readUInt32BE(entry + 8);
		const original = file.readUInt32BE(entry + 12);
		const bytes = file.subarray(offset, offset + compressed);
		// A table only larger compressed than raw is stored raw, per the spec.
		tables.set(tag, compressed < original ? inflateSync(bytes) : bytes);
	}
	return tables;
}

/**
 * The x-height of a face as a fraction of its em, `OS/2.sxHeight` over
 * `head.unitsPerEm`. `sxHeight` exists from OS/2 version 2; every face here is
 * version 4, and a version below 2 is a face this measurement cannot make.
 */
function xHeightRatio(pkg: string): number {
	const url = new URL(
		`../../node_modules/@fontsource/${pkg}/files/${pkg}-latin-400-normal.woff`,
		import.meta.url
	);
	const tables = woffTables(readFileSync(url));
	const head = tables.get("head");
	const os2 = tables.get("OS/2");
	if (!head || !os2) throw new Error(`${pkg}: no head/OS/2 table`);
	const version = os2.readUInt16BE(0);
	if (version < 2) throw new Error(`${pkg}: OS/2 version ${version} carries no sxHeight`);
	return os2.readInt16BE(86) / head.readUInt16BE(18);
}

/** The bundled faces a picker offers, as package name per option value. */
function bundled(options: readonly { value: string; stack: string }[]): Map<string, string> {
	const faces = new Map<string, string>();
	for (const option of options) {
		const face = promisedFace(option.stack);
		if (face) faces.set(option.value, fontsourcePackage(face));
	}
	return faces;
}

const uiFaces = bundled(UI_FONTS);
const monoFaces = bundled(MONO_FONTS);
const ratios = new Map(
	[...new Set([...uiFaces.values(), ...monoFaces.values()])].map((pkg) => [
		pkg,
		xHeightRatio(pkg),
	])
);

/** The body step, read from the token rather than restated as a number. */
const indexCss = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const bodyRem = Number(/--text-sm:\s*([\d.]+)rem/.exec(indexCss)?.[1]);
const bodyPx = bodyRem * 16;

const round = (value: number, places: number): number => Number.parseFloat(value.toFixed(places));

describe("the bundled faces' x-heights", () => {
	it("were read from real font files", () => {
		// Every assertion below is vacuous if the parse silently produced nothing.
		expect(ratios.size).toBe(6);
		expect(Number.isFinite(bodyPx) && bodyPx > 0).toBe(true);
		for (const [pkg, ratio] of ratios) {
			expect(ratio, `${pkg} parsed an implausible x-height ratio`).toBeGreaterThan(0.4);
			expect(ratio, `${pkg} parsed an implausible x-height ratio`).toBeLessThan(0.65);
		}
	});

	it("keep the default UI face at or below the reference register at the body step", () => {
		// The premise the register decision turned on: the default face is not
		// what reads large - 6.32px against the 6.50px a system face gives. Raise
		// --text-sm and this is the assertion that reds.
		const pkg = uiFaces.get(DEFAULT_UI_FONT);
		expect(pkg, `${DEFAULT_UI_FONT} promises no bundled face`).toBeDefined();
		const xHeight = (ratios.get(pkg as string) as number) * bodyPx;
		expect(round(xHeight, 2)).toBeLessThanOrEqual(REFERENCE_BODY_XHEIGHT);
	});

	it("keep every selectable UI face inside a step of the default at the body step", () => {
		// A face a user can pick may read larger than the default - Inter does -
		// but not by a whole step, or the picker would change the register.
		const defaultRatio = ratios.get(uiFaces.get(DEFAULT_UI_FONT) as string) as number;
		for (const [value, pkg] of uiFaces) {
			const xHeight = (ratios.get(pkg) as number) * bodyPx;
			expect(
				xHeight,
				`${value} reads a whole step above the default face`
			).toBeLessThanOrEqual(defaultRatio * (bodyPx + 2));
		}
	});

	it("keep the default code face inside an editor's register at the default size", () => {
		// The 13px -> 12px move (#1202). JetBrains Mono's 0.550 ratio is the
		// largest of the six: at 13px it renders 7.15px, above every editor this
		// is measured against. Revert DEFAULT_EDITOR_FONT_SIZE and this reds.
		const xHeight =
			(ratios.get(monoFaces.get(DEFAULT_MONO_FONT) as string) as number) *
			DEFAULT_EDITOR_FONT_SIZE;
		expect(round(xHeight, 2)).toBeGreaterThanOrEqual(EDITOR_XHEIGHT_BAND.min);
		expect(round(xHeight, 2)).toBeLessThanOrEqual(EDITOR_XHEIGHT_BAND.max);
	});

	it("keep every selectable code face inside that band too", () => {
		for (const [value, pkg] of monoFaces) {
			const xHeight = round((ratios.get(pkg) as number) * DEFAULT_EDITOR_FONT_SIZE, 2);
			expect(xHeight, `${value} at the default editor size`).toBeGreaterThanOrEqual(
				EDITOR_XHEIGHT_BAND.min
			);
			expect(xHeight, `${value} at the default editor size`).toBeLessThanOrEqual(
				EDITOR_XHEIGHT_BAND.max
			);
		}
	});
});

describe("the x-height table in docs/design-system.md", () => {
	const doc = readFileSync(fromRepoRoot(DOC_READING_GUARDS.fontMetrics.paths[0]), "utf8");

	/**
	 * `| Face | Role | x-height ratio | at 13px | at 12px |` rows, parsed rather
	 * than grepped so a table that moves is still found and a table that is gone
	 * fails the count below rather than passing on an empty scan.
	 */
	const rows = doc
		.split("\n")
		.filter((line) => line.startsWith("|") && !/^\|[-|\s]+\|$/.test(line))
		.map((line) =>
			line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim())
		)
		.filter((cells) => cells.length === 5 && /^0\.\d+$/.test(cells[2]));

	it("read the table", () => {
		expect(doc.length).toBeGreaterThan(1000);
		// Six bundled faces plus the system-face reference row.
		expect(rows.length).toBe(7);
	});

	it("quotes the ratio each bundled face actually carries", () => {
		const documented = new Map(rows.map((cells) => [fontsourcePackage(cells[0]), cells]));
		for (const [pkg, ratio] of ratios) {
			const cells = documented.get(pkg);
			expect(cells, `${pkg} has no row in the x-height table`).toBeDefined();
			const [, , quoted, atThirteen, atTwelve] = cells as string[];
			// Both sides through the same rounding, so a face whose ratio sits on
			// a half-thousandth boundary has one spelling rather than two.
			expect(Number(quoted).toFixed(3), `${pkg}'s documented ratio`).toBe(ratio.toFixed(3));
			expect(atThirteen).toBe(`${round(ratio * 13, 2).toFixed(2)}px`);
			expect(atTwelve).toBe(`${round(ratio * 12, 2).toFixed(2)}px`);
		}
	});

	it("names the system face it measures against", () => {
		const reference = rows.find((cells) => !ratios.has(fontsourcePackage(cells[0])));
		expect(reference?.[0]).toBe("Segoe UI");
		expect(Number(reference?.[2])).toBe(SYSTEM_FACE_RATIO);
	});
});
