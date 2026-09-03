/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * No editor in a request or collection tab is mounted at a pixel height.
 *
 * Three editors carried three different constants - 320px in `BodyPanel`,
 * 350px in `ScriptPanel`, 320px in the collection's `ScriptTab` - inside panes
 * that already have the window's height, so each showed a slice of an editor
 * over empty panel (#1323). They fill their pane now, with a `min-h-40` floor
 * and no ceiling.
 *
 * The rendered classes are asserted where the component is rendered
 * (`BodyPanel.test.tsx`, `script-panels.test.tsx`, `ScriptTab.chips.test.tsx`);
 * a class arriving in a variable is invisible to a scan. What a scan *can* see
 * is the constant coming back, which is the regression this guards: a fourth
 * editor added with `height="400px"` reads as ordinary until someone opens it
 * in a tall window.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** `app/src`, from this file's home three levels of components below it. */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

/** The two trees whose panels sit inside a full-height tab panel. */
const TREES = [
	"modules/request-builder/components/RequestTabs/panels",
	"modules/collections/CollectionDetail",
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
		// the same as a tree that is clean. BodyPanel, ScriptPanel and ScriptTab
		// are the three that mount an editor.
		expect(files.map((f) => f.path).sort()).toContain(
			"modules/collections/CollectionDetail/ScriptTab.tsx"
		);
		expect(files.length).toBeGreaterThanOrEqual(3);
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
