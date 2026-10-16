/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every dialog is one of a closed set of widths (issue #701, review follow-up).
 *
 * The sizes had drifted to five values across eleven call sites - `sm:max-w-md`,
 * `sm:max-w-lg`, `sm:max-w-xl`, `sm:max-w-[560px]` and a hard `w-[500px]` - so
 * two dialogs of the same kind came out different sizes depending on who wrote
 * them, and the most cramped of them held a data-file preview table. There are
 * now four: `lg` (512px) for a form or a decision, `xl` (576px) for a dialog
 * holding something with a shape of its own, `2xl` (672px) for one whose job
 * is *browsing* that shape - the data-row picker, added by issue #892 - and
 * `lg:max-w-3xl` (768px, from the `lg` breakpoint only) for a dense config that
 * is two independent groups laid in two panes, the load-test dialog (#2231).
 *
 * The scale grows by widening it here with a reason, which is what the last
 * assertion's message asks for; it does not grow by a call site quietly taking a
 * width of its own.
 *
 * This is a **source scan**, which is the weaker kind of guard, so it is scoped
 * to what only a scan can see - every call site at once - and it asserts it
 * actually read them. The rendered half (that the panel carries the clamp and
 * the cap at all) lives in `RunCollectionDialog.layout.test.tsx`, where the
 * class list comes off a real element.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every `.tsx` under `src`, so a new dialog cannot hide in a new folder. */
function tsxFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return tsxFiles(full);
		return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
			? [full]
			: [];
	});
}

/**
 * The width-ish classes on a `<DialogContent …>` opening tag. Kept to the
 * opening tag so a width class on some child inside the dialog is not read as
 * the panel's own.
 */
function panelWidths(source: string): string[] {
	const widths: string[] = [];
	for (const match of source.matchAll(/<DialogContent\b[\s\S]*?>/g)) {
		// Comments inside the opening tag are stripped before anything is read:
		// several of these call sites explain their width in a `//` note beside
		// it, and prose naming a class is not a class.
		const tag = match[0].replace(/\/\/[^\n]*/g, "");
		// Only the quoted class strings, and the leading boundary within them is
		// load-bearing too: without it `overflow-hidden` and `overflow-y-auto`
		// read as the widths "w-hidden" and "w-y-auto".
		for (const literal of tag.matchAll(/"([^"]*)"/g)) {
			for (const cls of literal[1].matchAll(
				/(?:^|\s)((?:sm:|lg:)?(?:max-)?w-\[?[\w.%[\]()-]+)/g
			)) {
				// `w-full` is the primitive's own base and says nothing about size.
				if (cls[1] !== "w-full") widths.push(cls[1]);
			}
		}
	}
	return widths;
}

const ALLOWED = new Set([
	"max-w-lg",
	"sm:max-w-lg",
	"max-w-xl",
	"sm:max-w-xl",
	// `2xl` (672px) is the browser size, opened for the data-row picker in
	// issue #892 - see the rationale on `DialogContent`.
	"max-w-2xl",
	"sm:max-w-2xl",
	// The two-pane size (#2231), spelled with the breakpoint so below `lg` the
	// dialog stays the `xl` single column. Only the prefixed spelling is listed:
	// a bare `max-w-3xl` would be the wider modal the scale does not take.
	"lg:max-w-3xl",
]);

describe("the dialog width scale", () => {
	const files = tsxFiles(srcRoot).filter((f) =>
		readFileSync(f, "utf8").includes("<DialogContent")
	);

	it("read a real set of call sites", () => {
		// The failure this exists to prevent: a scan whose regex stopped matching
		// passes forever while reading nothing. Eleven call sites today.
		expect(files.length).toBeGreaterThanOrEqual(8);
	});

	it("gives every dialog one of the sizes on the scale", () => {
		const offenders: string[] = [];
		for (const file of files) {
			for (const width of panelWidths(readFileSync(file, "utf8"))) {
				if (!ALLOWED.has(width)) {
					offenders.push(`${file.slice(srcRoot.length + 1)}: ${width}`);
				}
			}
		}
		// A dialog that genuinely needs its own width should widen the scale in
		// `dialog.tsx` and say why, rather than open a one-off here.
		expect(offenders).toEqual([]);
	});

	it("reads a breakpoint-prefixed width and refuses a bare unlisted one", () => {
		// `lg:max-w-3xl` is on the scale; the same size with no breakpoint, or
		// at another one, is a one-off the scan has to surface.
		const tag = (cls: string) => `<DialogContent className="${cls}">`;
		expect(panelWidths(tag("max-w-xl lg:max-w-3xl"))).toEqual(["max-w-xl", "lg:max-w-3xl"]);
		expect(panelWidths(tag("max-w-3xl")).filter((w) => !ALLOWED.has(w))).toEqual(["max-w-3xl"]);
		expect(panelWidths(tag("lg:max-w-4xl")).filter((w) => !ALLOWED.has(w))).toEqual([
			"lg:max-w-4xl",
		]);
	});

	it("still finds the widths it is checking, on the dialogs that set one", () => {
		// The other half of "it scanned something": the matcher has to come back
		// with widths, not just with files.
		const found = files.flatMap((f) => panelWidths(readFileSync(f, "utf8")));
		expect(found.length).toBeGreaterThanOrEqual(8);
	});
});
