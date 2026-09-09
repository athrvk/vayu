/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * No editor's `<CodeEditor>` prop is mounted at a pixel height.
 *
 * Three editors carried three different constants - 320px in `BodyPanel`,
 * 350px in `ScriptPanel`, 320px in the collection's `ScriptTab` - inside panes
 * that already have the window's height, so each showed a slice of an editor
 * over empty panel (#1323). They fill their pane's `height="100%"` now.
 *
 * The rendered classes are asserted where the component is rendered
 * (`BodyPanel.test.tsx`, `ElementList.test.tsx`); a class arriving in a
 * variable is invisible to a scan. What a scan *can* see is the constant
 * coming back, which is the regression this guards: a fourth editor added
 * with `height="400px"` reads as ordinary until someone opens it in a tall
 * window.
 *
 * `ScriptElementForm`'s box is the one deliberate exception to "no ceiling"
 * (issue #1605): it sits in an auto-height card, not a bounded pane, so its
 * *wrapping* `<div>` carries an inline pixel height the user drags between
 * `SCRIPT_EDITOR_MIN_HEIGHT` and `SCRIPT_EDITOR_MAX_HEIGHT` - `<CodeEditor>`
 * itself still takes no `height` prop, which is what this scan reads.
 *
 * `ScriptPanel` and the collection's `ScriptTab` are gone (issue #1512): a
 * script is a `script.pre` / `script.post` element now, and its editor lives
 * in `ScriptElementForm` (`components/shared/ElementList/`), the third tree
 * below.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** `app/src`, from this file's home three levels of components below it. */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

/** The trees whose panels sit inside a full-height tab panel. */
const TREES = [
	"modules/request-builder/components/RequestTabs/panels",
	"modules/collections/CollectionDetail",
	"components/shared/ElementList",
];

/** `height="320px"`, `height={320}`, `height="20rem"` - a fixed box either way. */
const PIXEL_HEIGHT = /height=(?:"[\d.]+(?:px|rem|em)"|\{\s*[\d.]+\s*\})/;

const files = TREES.flatMap((tree) =>
	globSync("**/*.tsx", { cwd: join(srcRoot, tree) })
		.filter((file) => !file.includes(".test."))
		.map((file) => ({
			path: `${tree}/${file}`,
			source: readFileSync(join(srcRoot, tree, file), "utf8"),
		}))
).filter(({ source }) => source.includes("<CodeEditor"));

describe("editors in a tab panel fill it", () => {
	it("scanned the files it is guarding", () => {
		// Vitest stubs a CSS import to "", and a glob that matches nothing reads
		// the same as a tree that is clean. BodyPanel and ScriptElementForm are
		// the two that mount an editor now.
		expect(files.map((f) => f.path).sort()).toContain(
			"components/shared/ElementList/ScriptElementForm.tsx"
		);
		expect(files.length).toBeGreaterThanOrEqual(2);
		for (const file of files) expect(file.source.length).toBeGreaterThan(200);
	});

	it("mounts no editor at a fixed height", () => {
		for (const file of files) {
			expect(PIXEL_HEIGHT.test(file.source), `${file.path} pins its editor's height`).toBe(
				false
			);
		}
	});
});
