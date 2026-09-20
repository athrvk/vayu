/**
 * @vitest-environment jsdom
 */

/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The call sites that opt into an icon motion, from two directions.
 *
 * `data-icon-motion` reaches the DOM two ways. Most call sites write the
 * attribute in JSX, where a source scan is the honest check - the attribute is
 * literally in the file, and what goes wrong is a file quietly losing it in a
 * refactor. One does not: a row action's glyph is drawn once for both menus
 * (`RowActionBody`), so the name arrives in a variable and no scan can see it -
 * the rule `app/CLAUDE.md` states for a class bound from a variable. Those get
 * rendered and read off the element.
 *
 * Both halves matter because the failure is silent either way: an attribute the
 * stylesheet has no rule for is inert, and a rule with no attribute anywhere is
 * dead CSS. `icon-motion.test.tsx` holds the stylesheet's half.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { render } from "@testing-library/react";
import { Trash2 } from "lucide-react";
import { ICON_MOTION } from "./icon-motion";
import { DRAWER_VIEWS } from "@/constants/drawer-views";
import { RowActionBody } from "@/components/shared/RowActionBody";
import { rowActionItemClass } from "@/components/shared/row-actions";
import { ContextBarSectionFrame } from "@/components/layout/context-bar/Section";

/** `src/`, so a call site is named once as a repository-ish path. */
const src = resolve(__dirname, "../..");

/** The files that spell a motion name in JSX, and the name each one spells. */
const LITERAL_CALL_SITES: Record<string, readonly string[]> = {
	"components/shared/KeyValueEditor/KeyValueRow.tsx": [ICON_MOTION.lid],
	"components/layout/Dock.tsx": [ICON_MOTION.spinOnce],
	"components/layout/context-bar/CodeSection.tsx": [ICON_MOTION.spinOnce],
	"components/layout/TitleBar.tsx": [ICON_MOTION.rotate90, ICON_MOTION.drop],
	"components/layout/TabStrip.tsx": [ICON_MOTION.rotate90],
	"components/layout/context-bar/Section.tsx": [ICON_MOTION.nudgeX, ICON_MOTION.nudgeY],
	// The bespoke motions #1707 added, one representative call site each. The
	// exhaustive claim is the "no name goes unspelled" case below; these are
	// the files where losing the attribute in a refactor would be hardest to
	// notice, because the control still looks and behaves exactly the same.
	"components/layout/CommandSearchBar.tsx": [ICON_MOTION.wiggle],
	"modules/collections/DataFilePicker.tsx": [ICON_MOTION.lift],
	"modules/collections/CollectionTree.tsx": [ICON_MOTION.drop],
	"modules/history/sidebar/RunItem.tsx": [ICON_MOTION.tiltPin],
	"modules/settings/main/SettingsMain.tsx": [ICON_MOTION.press, ICON_MOTION.spinBack],
	"modules/settings/main/panels/McpSettingsPanel.tsx": [ICON_MOTION.flash],
	"modules/inbox/index.tsx": [ICON_MOTION.scale],
};

/**
 * Every `.ts` and `.tsx` under `src/`, for the exhaustive scan.
 *
 * `.ts` too, because a motion reaches the DOM from a registry as often as from
 * JSX now: `drawer-views.ts` names the rail's six, `app-panels.ts` and
 * `engine-categories.ts` name the Settings drawer's fifteen, and a row action
 * names its own in `useTreeCrud.ts`. A `.tsx`-only scan reported every one of
 * those names as dead CSS.
 */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			out.push(...sourceFiles(path));
			continue;
		}
		if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(path);
	}
	return out;
}

describe("icon motion call sites that write the attribute in JSX", () => {
	it.each(Object.entries(LITERAL_CALL_SITES))("%s", (file, names) => {
		const source = readFileSync(resolve(src, file), "utf8");
		expect(source.length, `${file} read as nothing`).toBeGreaterThan(500);
		// `{...}`, not `="lid"`: the name comes from `ICON_MOTION` so a typo is
		// a compile error. Dock's is a conditional expression, hence the loose
		// left-hand side and the per-name check below.
		expect(source).toContain("data-icon-motion={");
		for (const name of names) {
			const key = Object.entries(ICON_MOTION).find(([, v]) => v === name)?.[0];
			expect(source, `${file} no longer spells ${name}`).toContain(`ICON_MOTION.${key}`);
		}
	});

	// A motion fires from its owner's hover, so the glyph needs one: a Button
	// (`[data-slot="button"]`) or an element carrying `group`. Both TitleBar
	// close buttons, TabStrip's tab row, Section's trigger and `RailButton`
	// (whose glyph's motion comes from `DRAWER_VIEWS`, #1687) are plain
	// elements, so they carry `group` explicitly - dropping it is the way this
	// stops working without anything looking wrong.
	it("spells every name the vocabulary exports, so no rule is dead CSS", () => {
		// The direction the per-file map cannot cover: a name in `ICON_MOTION`
		// with rules in the stylesheet and no call site anywhere is CSS nobody
		// will ever see run, and it reads in a diff exactly like a motion that
		// works. Both routes to the DOM count - the attribute written in JSX,
		// and a registry entry the renderer hands to a generic glyph.
		const files = sourceFiles(src).filter((f) => !/\.test\.tsx?$/.test(f));
		expect(files.length, "scanned no source at all").toBeGreaterThan(100);
		const spelled = new Set<string>();
		const byKey = new Map(Object.entries(ICON_MOTION).map(([key, name]) => [key, name]));
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const [key, name] of byKey) {
				if (source.includes(`ICON_MOTION.${key}`)) spelled.add(name);
			}
		}
		for (const { motion } of DRAWER_VIEWS) if (motion) spelled.add(motion);

		const unspelled = Object.values(ICON_MOTION).filter((name) => !spelled.has(name));
		expect(unspelled.join(", "), "these names have rules and no call site").toBe("");
	});

	it("keeps a group owner on the call sites that are not a Button", () => {
		for (const file of [
			"components/layout/TitleBar.tsx",
			"components/layout/TabStrip.tsx",
			"components/layout/context-bar/Section.tsx",
			"components/layout/Dock.tsx",
			"components/layout/RailButton.tsx",
			// #1707's two hand-rolled owners: the command search bar and the
			// import dropzone are bare `<button>` elements, which the
			// stylesheet's trigger selector does not match on its own.
			"components/layout/CommandSearchBar.tsx",
			"modules/collections/ImportModal.tsx",
		]) {
			expect(readFileSync(resolve(src, file), "utf8"), `${file} has no group owner`).toMatch(
				/\bgroup\b/
			);
		}
	});
});

describe("icon motion names that arrive in a variable", () => {
	it("puts a row action's motion on its glyph, and none on an action without one", () => {
		const { container } = render(
			<>
				<RowActionBody
					action={{
						label: "Delete",
						icon: Trash2,
						iconMotion: ICON_MOTION.lid,
						onSelect: () => {},
						destructive: true,
					}}
				/>
				<RowActionBody action={{ label: "Rename", icon: Trash2, onSelect: () => {} }} />
			</>
		);
		const [withMotion, without] = [...container.querySelectorAll("svg")];
		expect(withMotion.getAttribute("data-icon-motion")).toBe(ICON_MOTION.lid);
		// Absent, not empty: an empty attribute would match `[data-icon-motion]`
		// and inherit the duration custom property for nothing.
		expect(without.hasAttribute("data-icon-motion")).toBe(false);
	});

	it("gives a menu item the group its glyph's motion triggers from", () => {
		expect(rowActionItemClass({ label: "Delete", icon: Trash2, onSelect: () => {} })).toContain(
			"group"
		);
	});

	it("swaps the chevron's motion with the disclosure's direction", () => {
		const frame = (expanded: boolean) =>
			render(
				<ContextBarSectionFrame title="Auth" expanded={expanded} onToggle={() => {}}>
					<p>body</p>
				</ContextBarSectionFrame>
			)
				.container.querySelector("svg")
				?.getAttribute("data-icon-motion");

		expect(frame(true)).toBe(ICON_MOTION.nudgeY);
		expect(frame(false)).toBe(ICON_MOTION.nudgeX);
	});
});
