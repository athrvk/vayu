/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A card is `Card`, not a hand-rolled box (#2310).
 *
 * `Card` carries the whole recipe: the radius, the outline, the `bg-card
 * surface-card` pair that declares the `--rule` a divider inside it reads
 * (#2294), and the elevation. A box written out as `rounded-md border
 * bg-card surface-card p-3` is a copy that receives none of the primitive's
 * fixes, which is how they drifted onto a different radius, a different
 * border token and no shadow before they were moved over.
 *
 * The rule: one `className` that names a card surface (`bg-card` or
 * `surface-card`), a `border` and an `md`/`lg` radius is a card, and is written
 * `<Card>`. A box that is a card surface but not a card - an interactive tile,
 * a list row, a joined control, a status strip - goes in `NOT_A_CARD` below
 * with the reason it differs. Only the element's own `className` is read, and
 * a class that arrives in a variable is invisible to any source scan
 * (`app/CLAUDE.md`); the guard is a floor for the common copy, not a proof.
 *
 * Mutation check: put `rounded-md border border-rule bg-card surface-card p-3`
 * back on `ColumnAudit.tsx`'s box and this names the file; delete an entry from
 * `NOT_A_CARD` and it names that file too.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { openingTagAt, ownClassName } from "@/lib/jsx-opening-tags.testkit";
import { stripComments } from "@/lib/strip-comments.testkit";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..");

/** The primitive itself writes the recipe out; it is the one place that must. */
const PRIMITIVE = "components/ui/card.tsx";

const SURFACE = /^(?:bg-card|surface-card)$/;
const BORDER = /^border$/;
const MEDIUM_OR_LARGE_RADIUS = /^rounded(?:-[trblse]{1,2})?-(?:md|lg)$/;

/**
 * Boxes that wear the card surface and are not cards, keyed by path under
 * `src/` with how many such boxes the file holds. The rot test below fails when
 * a file stops holding exactly that many, so an entry cannot outlive its box.
 */
const NOT_A_CARD: Record<string, { boxes: number; reason: string }> = {
	"modules/welcome/components/ActionTile.tsx": {
		boxes: 1,
		reason: "a button tile; it is flat and hovers to `bg-accent`, where a Card's shadow would lift it",
	},
	"modules/welcome/components/DemoApiTile.tsx": {
		boxes: 1,
		reason: "a button tile, the same shape as ActionTile",
	},
	"modules/welcome/LauncherSkeleton.tsx": {
		boxes: 1,
		reason: "the loading stand-in for ActionTile, so it has to match the tile",
	},
	"modules/request-builder/components/LoadTestConfigDialog/ProfilePicker.tsx": {
		boxes: 1,
		reason: "a selectable radio tile whose border changes with the selection",
	},
	"modules/collections/ImportModal.tsx": {
		boxes: 1,
		reason: "a small chip beside a label, not a panel",
	},
	"modules/request-builder/components/UrlBar/index.tsx": {
		boxes: 1,
		reason: "the method and URL controls joined into one field; its border is the focus ring's",
	},
	"modules/request-builder/components/UrlBar/SendWithRowDialog.tsx": {
		boxes: 1,
		reason: "a one-line status strip inside the dialog",
	},
	"components/shared/ElementList/ScriptElementForm.tsx": {
		boxes: 1,
		reason: "an editor box that joins the one under it (`border-b-0`, top corners only)",
	},
	"components/shared/ElementList/index.tsx": {
		boxes: 1,
		reason: "a row repeated down a list; a shadow on each would turn the list into floating cards",
	},
	"modules/trash/sidebar/TrashItem.tsx": {
		boxes: 1,
		reason: "a row repeated down a list, and a composite focus target (`focus-row`)",
	},
	"modules/request-builder/components/RequestTabs/panels/ExamplesPanel.tsx": {
		boxes: 1,
		reason: "a row repeated down a list of saved examples",
	},
	"components/shared/response-viewer/TimingPhaseTiles.tsx": {
		boxes: 1,
		reason: "a dense tile in a strip of phase timings, a cell of the strip rather than a card",
	},
};

function sourcePath(file: string): string {
	return relative(srcRoot, file).split(sep).join("/");
}

function scannedFiles(): string[] {
	return globSync("**/*.tsx", { cwd: srcRoot })
		.filter((f) => !/\.test\.tsx$/.test(f.split(sep).join("/")))
		.map((f) => join(srcRoot, f))
		.filter((f) => sourcePath(f) !== PRIMITIVE);
}

/** The class tokens in every string and template literal of one `className` value. */
function classTokens(classValue: string): string[] {
	const literals = classValue.matchAll(/"([^"]*)"|`([^`]*)`/g);
	return [...literals].flatMap((m) => (m[1] ?? m[2] ?? "").split(/\s+/)).filter(Boolean);
}

function isHandRolledCard(tokens: string[]): boolean {
	return (
		tokens.some((t) => SURFACE.test(t)) &&
		tokens.some((t) => BORDER.test(t)) &&
		tokens.some((t) => MEDIUM_OR_LARGE_RADIUS.test(t))
	);
}

/** One entry per element in `source` whose own `className` is a hand-rolled card. */
function handRolledCards(source: string): string[] {
	const code = stripComments(source);
	const hits: string[] = [];
	for (const m of code.matchAll(/<[A-Za-z][\w.]*(?=[\s/>])/g)) {
		const classValue = ownClassName(openingTagAt(code, m.index));
		if (classValue && isHandRolledCard(classTokens(classValue))) {
			hits.push(`${m[0]} ${classTokens(classValue).join(" ")}`);
		}
	}
	return hits;
}

/** The offences in `source`, with the allowance for `path` spent first-come. */
function offencesIn(path: string, source: string, allowed: typeof NOT_A_CARD): string[] {
	return handRolledCards(source)
		.slice(allowed[path]?.boxes ?? 0)
		.map((hit) => `${path}: ${hit}`);
}

describe("a card is the Card primitive, not a hand-rolled box", () => {
	it("scans a non-empty set of files, many of them already on Card", () => {
		// A guard that reads nothing passes forever and reads as coverage.
		const files = scannedFiles();
		expect(files.length).toBeGreaterThan(100);
		const onCard = files.filter((f) => /<Card[\s>]/.test(readFileSync(f, "utf8")));
		expect(onCard.length).toBeGreaterThanOrEqual(30);
	});

	it("finds no hand-rolled card outside the allowlist", () => {
		const offences = scannedFiles().flatMap((file) =>
			offencesIn(sourcePath(file), readFileSync(file, "utf8"), NOT_A_CARD)
		);
		expect(offences.join("\n")).toBe("");
	});

	it("keeps every allowance pointing at exactly its non-card boxes", () => {
		const entries = Object.entries(NOT_A_CARD);
		expect(entries.length).toBeGreaterThan(0);
		for (const [path, { boxes }] of entries) {
			const source = readFileSync(join(srcRoot, path), "utf8");
			expect(handRolledCards(source), `${path} box count`).toHaveLength(boxes);
		}
	});

	it.each([
		[
			"the full recipe",
			'<div className="rounded-md border border-rule bg-card surface-card p-3" />',
		],
		["the surface class alone", '<div className="rounded-lg border surface-card" />'],
		["a bare bg-card", '<section className="border bg-card rounded-md" />'],
		["a one-sided radius", '<div className="rounded-t-md border surface-card" />'],
		[
			"a class across cn() arguments",
			'<div className={cn("rounded-md bg-card", "border px-3")} />',
		],
		["a template literal", "<div className={`rounded-lg border bg-card ${extra}`} />"],
		[
			"a className after other attributes",
			'<Foo a={() => 1} className="border rounded-md bg-card" />',
		],
		[
			"a multi-line tag",
			'<div\n\tid="x"\n\tclassName={cn("rounded-md", "border", "surface-card")}\n/>',
		],
	])("flags %s", (_label, jsx) => {
		expect(handRolledCards(jsx)).toHaveLength(1);
	});

	it.each([
		["no border", '<div className="rounded-md bg-card p-3" />'],
		["no radius", '<div className="border-b border-rule surface-card" />'],
		["a small radius", '<div className="rounded-sm border bg-card" />'],
		["a full radius", '<span className="rounded-full border bg-card" />'],
		["no card surface", '<div className="rounded-md border bg-muted" />'],
		["a variant-only surface", '<div className="rounded-md border hover:bg-card" />'],
		["a border side only", '<div className="rounded-md border-t bg-card" />'],
		["a Card", '<Card className="overflow-hidden" />'],
		["a class in a comment", '// <div className="rounded-md border bg-card" />\n<div />'],
		[
			"an element passed as a prop",
			'<Foo className="p-2" icon={<i className="p-1" />} data-x="rounded-md border bg-card" />',
		],
	])("does not flag %s", (_label, jsx) => {
		expect(handRolledCards(jsx)).toEqual([]);
	});

	it("spends an allowance on its box count and flags a further box in the same file", () => {
		const box = '<div className="rounded-md border bg-card" />';
		const allowed = { "a.tsx": { boxes: 1, reason: "test" } };
		expect(offencesIn("a.tsx", box, allowed)).toEqual([]);
		expect(offencesIn("a.tsx", box + box, allowed)).toHaveLength(1);
		expect(offencesIn("b.tsx", box, allowed)).toHaveLength(1);
	});
});
