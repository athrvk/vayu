/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Icons are sized by token, not by an arbitrary 3.5 step (issue #1693).
 *
 * `--spacing-icon` (16px) and `--spacing-icon-sm` (12px) are the app's two
 * icon sizes, and `size-icon`/`size-icon-sm` were already the dominant form -
 * but a third, tokenless size survived at 152 call sites as `h-3.5 w-3.5`,
 * `w-3.5 h-3.5` and `size-3.5` (14px), doing the same job in the same rows:
 * a chip's status glyph, a button's leading icon, a row's trailing action.
 * Three spellings of one intent is exactly what a token exists to collapse,
 * and an arbitrary value is a fixed length besides, so those icons were the
 * only ones in the app that could not follow a token if it ever moves.
 *
 * The sweep normalised all of them to `size-icon-sm`, which is the 12px
 * token rather than the 14px they drew - a deliberate 2px step down onto the
 * scale, not a translation. `size-icon` was wrong for them: every one of
 * these sits beside `text-sm` or smaller text where the 16px default reads a
 * size too loud, which is why they were written smaller than the default in
 * the first place.
 *
 * Scope is the whole `.tsx` tree because the defect is the spelling, not a
 * particular pane. The bare `h-3.5` in `PaletteResults`' `h-icon-sm w-0.5`
 * rail was the one non-icon use and moved to the token too, so this can ban
 * the pair without a single exemption.
 *
 * The second scan holds the floor under the first. The 3.5 ban read one narrow
 * shape, so a glyph that `--spacing` draws BELOW the 12px token (`size-3` is 9px,
 * `h-2.5 w-2.5` 7.5px) or that spells a length by hand (`w-[15px]`) passed
 * (#2304). A lucide glyph, or `RunStatusGlyph`, takes `size-icon-sm` or
 * `size-icon` and nothing else. Two glyphs are drawn smaller on purpose, inside
 * a box that is itself the control, and are listed in `SMALL_GLYPH_ALLOWED`
 * with the reason. Only the glyph's own `className` is read: a span dot, a
 * skeleton or a `fill-current` Circle is a shape, not an icon, and a class that
 * arrives in a variable is invisible to any source scan (`app/CLAUDE.md`).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { stripComments } from "@/lib/strip-comments.testkit";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..");

// `h-3.5 w-3.5`, `w-3.5 h-3.5`, `size-3.5`, with or without a variant prefix.
const RAW_ICON_SIZE = /\b(?:h-3\.5 w-3\.5|w-3\.5 h-3\.5|(?:[a-z-]+:)*size-3\.5)\b/g;

// A glyph size that is not a token: a `--spacing` step under the 12px floor
// (N <= 3 is at most 9px) or an arbitrary px length. `3.5` and up are the
// first scan's, and the lookarounds keep `h-2.5` from matching as `h-2`.
const UNTOKENED_GLYPH_SIZE =
	/(?<![\w.-])(?:[a-z-]+:)*(?:size-(?:0\.5|1|1\.5|2|2\.5|3)|[hw]-(?:1|1\.5|2|2\.5|3)|[hw]-\[\d+px\])(?![\w./-])/;

// A lucide `Circle` painted solid is a radio's dot, a shape the control sizes, not an icon.
const FILLED_DOT = /(?<![\w-])fill-current(?![\w-])/;

const LUCIDE_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']lucide-react["']/g;

/** The local names `code` imports from lucide-react, aliases resolved, plus the app's own glyph. */
function glyphNames(code: string): string[] {
	const names = ["RunStatusGlyph"];
	for (const [, specifiers] of code.matchAll(LUCIDE_IMPORT)) {
		for (const specifier of specifiers.split(",")) {
			const local = specifier
				.trim()
				.split(/\s+as\s+/)
				.pop()
				?.replace(/^type\s+/, "");
			if (local && /^[A-Z]\w*$/.test(local) && local !== "LucideIcon") names.push(local);
		}
	}
	return names;
}

/** The opening tag's text from `start`: up to the first `>` outside quotes and braces. */
function openingTag(code: string, start: number): string {
	let depth = 0;
	let quote = "";
	for (let i = start; i < code.length; i++) {
		const c = code[i];
		if (quote) {
			if (c === quote) quote = "";
		} else if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "{") depth++;
		else if (c === "}") depth--;
		else if (c === ">" && depth === 0) return code.slice(start, i);
	}
	return code.slice(start);
}

/**
 * The value of `tag`'s own `className`, wherever it sits among the attributes. A
 * glyph passed as a prop (`icon={<X className="size-3" />}`) is at brace depth 1
 * and is a different element's box.
 */
function ownClassName(tag: string): string {
	let depth = 0;
	for (let i = 0; i < tag.length; i++) {
		if (tag[i] === "{") depth++;
		else if (tag[i] === "}") depth--;
		else if (depth === 0 && tag.startsWith("className=", i)) {
			return attributeValue(tag, i + "className=".length);
		}
	}
	return "";
}

/** The quoted string or balanced `{...}` expression starting at `start`. */
function attributeValue(tag: string, start: number): string {
	const open = tag[start];
	if (open === '"' || open === "'") {
		return tag.slice(start, tag.indexOf(open, start + 1) + 1);
	}
	let depth = 0;
	for (let i = start; i < tag.length; i++) {
		if (tag[i] === "{") depth++;
		else if (tag[i] === "}" && --depth === 0) return tag.slice(start, i + 1);
	}
	return tag.slice(start);
}

/** One `<Glyph class` entry per glyph in `source` whose own className is not a token. */
function untokenedGlyphs(source: string): string[] {
	const code = stripComments(source);
	const names = glyphNames(code);
	const open = new RegExp(`<(${names.join("|")})(?=[\\s/>])`, "g");
	const hits: string[] = [];
	for (const m of code.matchAll(open)) {
		const classes = ownClassName(openingTag(code, m.index));
		if (FILLED_DOT.test(classes)) continue;
		const size = classes.match(UNTOKENED_GLYPH_SIZE)?.[0];
		if (size) hits.push(`<${m[1]} ${size}`);
	}
	return hits;
}

function scannedFiles(): string[] {
	return globSync("**/*.tsx", { cwd: srcRoot })
		.filter((f) => !/\.test\.tsx$/.test(f))
		.map((f) => join(srcRoot, f));
}

describe("icon sizes use the spacing tokens, not an arbitrary 3.5", () => {
	it("scans a non-empty set of files", () => {
		// A guard that reads nothing passes forever and reads as coverage.
		expect(scannedFiles().length).toBeGreaterThan(100);
	});

	it("finds no raw 3.5 icon sizes", () => {
		// Mutation check: put `h-3.5 w-3.5` back on any icon and this reds.
		const offences: string[] = [];

		for (const file of scannedFiles()) {
			const source = readFileSync(file, "utf8");
			const code = stripComments(source).split(/\r?\n/);
			source.split(/\r?\n/).forEach((line, i) => {
				const hits = code[i]?.match(RAW_ICON_SIZE);
				if (hits) {
					offences.push(`${relative(srcRoot, file)}:${i + 1}  ${line.trim()}`);
				}
			});
		}

		expect(offences.join("\n")).toBe("");
	});
});

describe("a glyph is drawn at a token size, not below it or around it", () => {
	// Drawn smaller than the 12px token on purpose. Keyed by path under `src/`
	// with the exact number of glyph tags allowed: a further small glyph in the
	// same file is an offence, and the rot test below fails when the file stops
	// carrying exactly that many, so an entry cannot outlive its glyph.
	const SMALL_GLYPH_ALLOWED: Record<string, { tags: number; reason: string }> = {
		"components/ui/info-chip.tsx": {
			tags: 1,
			reason: "the 'i' inside the chip's own 12px dot; at the token it would fill the dot edge to edge",
		},
		"components/ui/resizable.tsx": {
			tags: 1,
			reason: "the grip inside a handle box that carries its own border",
		},
	};

	const GLYPH_IMPORT = 'import { Circle, Pin, Info as Hint } from "lucide-react";\n';

	function sourcePath(file: string): string {
		return relative(srcRoot, file).split(sep).join("/");
	}

	/** One line per untokened glyph in `source`, the allowance for `path` spent first-come. */
	function offencesIn(
		path: string,
		source: string,
		allowed: typeof SMALL_GLYPH_ALLOWED
	): string[] {
		return untokenedGlyphs(source)
			.slice(allowed[path]?.tags ?? 0)
			.map((hit) => `${path}: ${hit}`);
	}

	it.each([
		["size-3", '<Pin className="size-3 shrink-0" />', "<Pin size-3"],
		["h-2.5 w-2.5", '<Pin className="h-2.5 w-2.5" />', "<Pin h-2.5"],
		["w-[15px] h-[15px]", '<Pin className="w-[15px] h-[15px]" />', "<Pin w-[15px]"],
		["a variant-prefixed size", '<Pin className="sm:size-2" />', "<Pin sm:size-2"],
		["an aliased import", '<Hint className="size-1" />', "<Hint size-1"],
		[
			"RunStatusGlyph",
			'<RunStatusGlyph status={s} className="size-3" />',
			"<RunStatusGlyph size-3",
		],
		[
			"a className after other attributes",
			'<Pin aria-hidden onClick={() => go()} className="w-2" />',
			"<Pin w-2",
		],
		[
			"a multi-line tag",
			'<Pin\n\taria-hidden\n\tclassName={cn("a", "h-1.5 w-1.5")}\n/>',
			"<Pin h-1.5",
		],
	])("flags %s", (_label, jsx, expected) => {
		expect(untokenedGlyphs(`${GLYPH_IMPORT}${jsx}`)).toEqual([expected]);
	});

	it.each([
		["the 12px token", '<Pin className="size-icon-sm" />'],
		["the 16px token", '<Pin className="size-icon" />'],
		["a larger step", '<Pin className="size-4 h-5 w-5" />'],
		["the first scan's 3.5, left to it", '<Pin className="size-3.5" />'],
		["a fraction", '<Pin className="w-1/2 h-3/4" />'],
		["a span dot", '<span className="size-2 rounded-full" />'],
		["a skeleton", '<Skeleton className="h-3 w-10" />'],
		["a solid dot drawn with a glyph", '<Circle className="size-2 fill-current" />'],
		[
			"an element passed as a prop",
			'<Pin className="size-icon" data-badge={<span className="size-3" />} />',
		],
		["a size in a comment", '// <Pin className="size-3" />\n<Pin className="size-icon-sm" />'],
	])("does not flag %s", (_label, jsx) => {
		expect(untokenedGlyphs(`${GLYPH_IMPORT}${jsx}`)).toEqual([]);
	});

	it("takes a lucide name only from the lucide import", () => {
		const elsewhere = 'import { Pin } from "./pin";\n<Pin className="size-3" />';
		expect(untokenedGlyphs(elsewhere)).toEqual([]);
	});

	it("scans a non-empty set of files and glyphs", () => {
		const files = scannedFiles();
		expect(files.length).toBeGreaterThan(100);
		const glyphTags = files.flatMap((f) => {
			const code = stripComments(readFileSync(f, "utf8"));
			return [...code.matchAll(new RegExp(`<(?:${glyphNames(code).join("|")})\\b`, "g"))];
		});
		expect(glyphTags.length).toBeGreaterThan(100);
	});

	it("finds no glyph below or around the icon tokens", () => {
		// Mutation check: put `size-3` back on `RunStatusPill`'s glyph and this reds.
		const offences = scannedFiles().flatMap((file) =>
			offencesIn(sourcePath(file), readFileSync(file, "utf8"), SMALL_GLYPH_ALLOWED)
		);
		expect(offences.join("\n")).toBe("");
	});

	it("spends an allowance on its allowed count and flags a further glyph in the same file", () => {
		const glyph = '<Pin className="h-2.5 w-2.5" />';
		const allowed = { "a.tsx": { tags: 1, reason: "test" } };
		expect(offencesIn("a.tsx", `${GLYPH_IMPORT}${glyph}`, allowed)).toEqual([]);
		expect(offencesIn("a.tsx", `${GLYPH_IMPORT}${glyph}${glyph}`, allowed)).toEqual([
			"a.tsx: <Pin h-2.5",
		]);
		expect(offencesIn("b.tsx", `${GLYPH_IMPORT}${glyph}`, allowed)).toEqual([
			"b.tsx: <Pin h-2.5",
		]);
	});

	it("keeps every allowance pointing at exactly its small glyph tags", () => {
		const entries = Object.entries(SMALL_GLYPH_ALLOWED);
		expect(entries.length).toBeGreaterThan(0);
		for (const [path, { tags }] of entries) {
			const source = readFileSync(join(srcRoot, path), "utf8");
			expect(untokenedGlyphs(source), `${path} small glyph count`).toHaveLength(tags);
		}
	});
});
