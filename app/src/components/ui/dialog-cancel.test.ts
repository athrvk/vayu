/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Cancel" is drawn by one primitive (issue #1693).
 *
 * It used to be drawn by three: `outline` in five dialogs, `secondary` in
 * three, `ghost` in three, and one hand-rolled `<button>` with a copied class
 * list in `SendWithRowDialog`. Nothing distinguished them - same word, same
 * job, same position beside the confirm - so the variant a user saw depended
 * on which dialog they had opened. `DialogCancelButton` settles it on
 * `secondary`, matching `DeleteConfirmDialog`, the dialog this app shows most.
 *
 * This guard is a source scan rather than a render assertion because the
 * defect is a call site choosing for itself, which no rendered tree can show.
 * It bans a `Cancel` label on anything but the primitive, in `<Button>Cancel`
 * form or as a bare `<button>` - the two spellings that were actually there.
 * The primitive's own default label is the one allowed occurrence.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { stripComments } from "@/lib/strip-comments.testkit";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..");
const PRIMITIVE = join("components", "ui", "dialog-cancel-button.tsx");

/**
 * `<Button …>Cancel</Button>` or `<button …>Cancel</button>`, however the
 * attributes are wrapped. Prettier puts the label on its own line whenever
 * the opening tag breaks, which is why this has to span lines - the literal
 * `>Cancel<` the issue's acceptance criterion greps for never appears in a
 * formatted file, and a single-line guard would have passed over all twelve.
 */
const CANCEL_BUTTON = /<[Bb]utton\b[^>]*>\s*Cancel\s*<\/[Bb]utton>/g;

function scannedFiles(): string[] {
	return globSync("**/*.tsx", { cwd: srcRoot })
		.filter((f) => !/\.test\.tsx$/.test(f) && f.split("/").join(sep) !== PRIMITIVE)
		.map((f) => join(srcRoot, f));
}

describe("Cancel is DialogCancelButton everywhere", () => {
	it("scans a non-empty set of files", () => {
		expect(scannedFiles().length).toBeGreaterThan(100);
	});

	it("the primitive is the only thing that draws the word", () => {
		// Mutation check: restore any of the twelve `<Button …>Cancel</Button>`
		// blocks and this reds with that file and line.
		const offences: string[] = [];

		for (const file of scannedFiles()) {
			const code = stripComments(readFileSync(file, "utf8"));
			if (CANCEL_BUTTON.test(code)) {
				offences.push(relative(srcRoot, file));
			}
			CANCEL_BUTTON.lastIndex = 0;
		}

		expect(offences.join("\n")).toBe("");
	});

	it("the primitive itself is secondary, and does not let a caller choose", () => {
		const source = readFileSync(join(srcRoot, PRIMITIVE), "utf8");
		expect(source.length).toBeGreaterThan(500);
		expect(source).toContain('variant="secondary"');
		// The variant is omitted from the prop type on purpose: a caller that
		// can choose is a caller that can drift back to three variants.
		expect(source.replace(/\s+/g, " ")).toContain('Omit< ButtonProps, "variant" | "children" | "asChild" >');
	});
});
