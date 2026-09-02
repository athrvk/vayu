/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `outline-none` removes the one indicator every focusable element gets for
 * free, so the class string that writes it must also write a replacement.
 *
 * The baseline lives in `index.css` (`@layer base`, specificity 0) and covers
 * every interactive element without a per-component class - which is exactly
 * why `outline-none` is dangerous here: it is the single token that opts an
 * element out of the app's whole focus story, and nothing said so. The command
 * palette's input had opted out since it was written (#1216) and nobody saw it,
 * because it is the only focusable element in its dialog: there is no second
 * control for the ring to be missing *next to*.
 *
 * The scan is per class string, not per line. Class strings here are wrapped by
 * prettier and split across `cn()` arguments, so `outline-none` and its
 * replacement routinely sit on different lines - and the neighbouring-lines
 * window `row-action-reveal.test.ts` uses would also accept an indicator that
 * belongs to a *different* element eight lines away. Reading the whole `cn()`
 * call is both stricter and free of that false negative.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { blankComments, literalMask } from "@/lib/jsx-opening-tags.testkit";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What counts as a replacement indicator.
 *
 * `focus-within:` is here because a borderless input inside a wrapper that
 * paints the ring is a real pattern (`VariableInput`, `CommandInput`) - the
 * indicator moves to the wrapper, it does not disappear. The two `data-`
 * variants are the menu/listbox convention: cmdk and Radix mark the active
 * option with a background fill rather than a ring, since a roving highlight
 * that painted a focus ring on every arrow press would flicker.
 */
const INDICATORS = [
	"focus-visible:",
	"focus:",
	"focus-within:",
	"data-[selected",
	"data-[highlighted",
];

/**
 * The helper calls whose arguments are one class string between them.
 *
 * `cva` is deliberately absent. Its arguments are a base string and an object
 * of variants, only some of which are ever applied, so an indicator in one
 * variant does not answer for an `outline-none` in the base - reading the whole
 * call would let a ring on `variant="ghost"` cover a bare `variant="default"`.
 * An occurrence inside a `cva()` is therefore read as its own literal.
 */
const CLASS_HELPER = /\b(cn|clsx)\s*$/;

/**
 * Every element with `outline-none` that is deliberately without an indicator
 * of its own, and why. Keyed by a distinctive substring of the class string, so
 * an exemption stops applying the moment the element it was written for is
 * restyled - a bare file path would silently cover a *new* offender in the same
 * file (`toast.tsx` holds three `outline-none` strings, two of them ringed).
 *
 * `requires` is what makes "the wrapper paints it" checkable rather than a
 * claim: the class named there has to still be in the file, so deleting the
 * wrapper's ring fails this guard at the element that depends on it.
 */
const EXEMPT: readonly { file: string; marker: string; why: string; requires?: string }[] = [
	{
		file: "components/ui/popover.tsx",
		marker: "origin-[--radix-popover-content-transform-origin]",
		why: "PopoverContent is the panel, not a control: Radix moves focus to the first focusable element inside it, and the panel itself is never a tab stop.",
	},
	{
		file: "components/ui/toast.tsx",
		marker: "fixed z-[100]",
		why: "ToastViewport is the stack's positioned container. Its two controls - the close and action buttons below - carry their own focus-visible rings.",
	},
	{
		file: "components/ui/command.tsx",
		marker: "flex h-10 w-full bg-transparent py-3",
		why: "CommandInput is flush in a full-bleed row; its wrapper paints focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring (#1216).",
		requires: "focus-within:ring-inset",
	},
	{
		file: "components/shared/VariableInput/index.tsx",
		marker: "absolute inset-0 w-full h-full bg-transparent border-0",
		why: "The input layer is borderless by design; the wrapper it fills paints focus-within:ring-1 focus-within:ring-ring for it.",
		requires: "focus-within:ring-ring",
	},
];

/**
 * The whole class string an occurrence belongs to: the arguments of the
 * enclosing `cn()` / `clsx()` call, or - for a plain `className="…"`, and for
 * a `cva()` whose variants are not all applied at once - the literal itself.
 *
 * Parentheses inside literals do not count, which is what the mask is for: a
 * class like `origin-[--radix-popover-content-transform-origin]` holds none,
 * but `[&>span]:line-clamp-1` and arrow-function props nearby hold plenty.
 */
export function classStringAt(source: string, at: number): string {
	const inLiteral = literalMask(source);

	let depth = 0;
	let opener = -1;
	for (let i = at; i >= 0; i--) {
		if (inLiteral[i]) continue;
		if (source[i] === ")") depth++;
		else if (source[i] === "(") {
			if (depth === 0) {
				opener = i;
				break;
			}
			depth--;
		}
	}
	if (opener === -1 || !CLASS_HELPER.test(source.slice(Math.max(0, opener - 12), opener))) {
		// A plain attribute: the literal around the occurrence is the whole string.
		let start = at;
		while (start > 0 && inLiteral[start - 1]) start--;
		let end = at;
		while (end < source.length - 1 && inLiteral[end + 1]) end++;
		return source.slice(start, end + 1);
	}

	let close = opener;
	for (let i = opener + 1, open = 1; i < source.length; i++) {
		if (inLiteral[i]) continue;
		if (source[i] === "(") open++;
		else if (source[i] === ")" && --open === 0) {
			close = i;
			break;
		}
	}
	return source.slice(opener + 1, close);
}

const scanned = globSync("**/*.{ts,tsx}", { cwd: srcRoot }).filter(
	(file) => !file.includes(".test.") && !file.includes(".testkit.")
);

interface Occurrence {
	readonly file: string;
	readonly line: number;
	readonly classString: string;
}

const occurrences: Occurrence[] = scanned.flatMap((file) => {
	const source = blankComments(readFileSync(join(srcRoot, file), "utf8"));
	const found: Occurrence[] = [];
	for (
		let at = source.indexOf("outline-none");
		at !== -1;
		at = source.indexOf("outline-none", at + 1)
	) {
		found.push({
			file: file.split("\\").join("/"),
			line: source.slice(0, at).split("\n").length,
			classString: classStringAt(source, at),
		});
	}
	return found;
});

const isExempt = (occurrence: Occurrence) =>
	EXEMPT.some(
		(entry) => entry.file === occurrence.file && occurrence.classString.includes(entry.marker)
	);

describe("outline-none carries a replacement indicator", () => {
	it("scans a real set of files and occurrences", () => {
		// Both floors, because either one can go quietly to zero: a broken glob
		// empties the file list, and a rename of the class empties the occurrence
		// list while the files still scan. There were 42 occurrences in 31 files
		// when this was written.
		expect(scanned.length).toBeGreaterThan(100);
		expect(occurrences.length).toBeGreaterThan(30);
	});

	it("pairs every occurrence with an indicator, or exempts it with a reason", () => {
		const offenders = occurrences
			.filter((occurrence) => !isExempt(occurrence))
			.filter(({ classString }) => !INDICATORS.some((token) => classString.includes(token)))
			.map(
				({ file, line }) =>
					`${relative(".", file)}:${line} outline-none with no focus indicator`
			);

		expect(offenders.join("\n")).toBe("");
	});

	it("keeps every exemption pointed at code that still exists", () => {
		// An exemption that matches nothing is an exemption nobody removed. It
		// would also mean the file below no longer says what the reason claims.
		const unused = EXEMPT.filter(
			(entry) =>
				!occurrences.some(
					(occurrence) =>
						occurrence.file === entry.file &&
						occurrence.classString.includes(entry.marker)
				)
		).map((entry) => `${entry.file}: ${entry.marker}`);

		expect(unused.join("\n")).toBe("");
	});

	it("holds the wrapper that each borrowed indicator comes from", () => {
		const broken = EXEMPT.filter((entry) => entry.requires)
			.filter(
				(entry) =>
					!readFileSync(join(srcRoot, entry.file), "utf8").includes(
						entry.requires as string
					)
			)
			.map((entry) => `${entry.file} no longer carries ${entry.requires}: ${entry.why}`);

		expect(broken.join("\n")).toBe("");
	});
});

describe("the class-string reader", () => {
	// The scan is only as good as this: read one line of a wrapped `cn()` call
	// and a split class string reports a false offence; read too greedily and a
	// neighbouring element's ring covers a real one.
	it("reads every argument of a wrapped cn() call", () => {
		const source = 'className={cn(\n"h-9 outline-none",\n"focus-visible:ring-1"\n)}';
		expect(classStringAt(source, source.indexOf("outline-none"))).toContain("focus-visible:");
	});

	it("stops at the call it is in, not the next one", () => {
		const source = 'cn("outline-none")\ncn("focus-visible:ring-1")';
		expect(classStringAt(source, source.indexOf("outline-none"))).not.toContain(
			"focus-visible:"
		);
	});

	it("reads a plain attribute as its own literal", () => {
		const source = '<input className="outline-none" />\n<b className="focus-visible:ring-1" />';
		expect(classStringAt(source, source.indexOf("outline-none"))).toBe('"outline-none"');
	});

	it("reads a cva() occurrence as its own literal, not the variant block", () => {
		const source =
			'cva("h-9 outline-none", {\nvariants: { v: { ghost: "focus-visible:ring-1" } },\n})';
		expect(classStringAt(source, source.indexOf("outline-none"))).not.toContain(
			"focus-visible:"
		);
	});

	it("is not confused by parentheses inside a class", () => {
		const source =
			'className={cn(\n"[&:not(:disabled)]:outline-none",\n"focus-visible:ring-1"\n)}';
		expect(classStringAt(source, source.indexOf("outline-none"))).toContain("focus-visible:");
	});
});
