/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The half of the snippet insertion that lives in `monaco-editor`, checked
 * against the copy this app actually ships.
 *
 * `editor-snippet.test.ts` proves what the app does with a controller it is
 * given. It cannot prove the controller exists, because a fake is what it hands
 * itself - and that gap is exactly how `"editor.action.insertSnippet"` shipped:
 * a plausible id, no such action in this build, no error, no effect (#1223).
 *
 * So this reads the installed package. Monaco does not run under jsdom, and
 * standing an editor up to insert into it would be a browser test the suite has
 * no place for; what is checkable here is the one fact the app depends on and
 * cannot see: that the snippet controller is registered as an editor
 * contribution under the id `editor-snippet.ts` asks for. A `monaco-editor`
 * upgrade that renames or unregisters it fails here, in a case that says why,
 * rather than in a click that does nothing.
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/**
 * Resolved as the module it is, rather than joined onto the package root:
 * `monaco-editor`'s `main` is the bundled `min/` build, while the app imports
 * the `esm/` tree that Vite splits, and pnpm's store layout is not a path
 * anyone should hardcode.
 *
 * It used to anchor on `monaco-editor/package.json` and walk down from there.
 * 0.56's `exports` map ends that: `./*` maps into `esm/vs/`, so the manifest
 * itself is no longer a resolvable subpath and the walk threw before any
 * assertion ran (#1342). Resolving the controller directly is both shorter and
 * the thing actually being asserted - and a version that moves it fails here,
 * loudly, which is this file's whole job.
 */
const require_ = createRequire(import.meta.url);
const CONTROLLER_PATH = require_.resolve(
	"monaco-editor/editor/contrib/snippet/browser/snippetController2.js"
);

describe("the snippet controller this app drives", () => {
	const source = readFileSync(CONTROLLER_PATH, "utf-8");

	it("is registered under the id editor-snippet.ts asks for", () => {
		expect(source).toMatch(/this\.ID = ['"]snippetController2['"]/);
		expect(source).toMatch(/registerEditorContribution\(\s*SnippetController2\w*\.ID/);
	});

	it("still takes the template through insert()", () => {
		expect(source).toMatch(/insert\(template(,\s*opts)?\)\s*\{/);
	});

	/*
	 * The negative half, and the reason this file exists: the action id the
	 * first implementation used belongs to VS Code's workbench, and the
	 * standalone editor registers nothing by that name. If a future Monaco
	 * adds one, `editor.trigger` becomes a legitimate second door and this
	 * case is the place to reconsider - but nothing should quietly rely on it
	 * while it is absent.
	 */
	it("registers no editor.action.insertSnippet, which is what made the wrong id silent", () => {
		expect(source).not.toContain("editor.action.insertSnippet");
	});

	it("read the file it thinks it read", () => {
		expect(source.length).toBeGreaterThan(2_000);
		expect(source).toContain("SnippetController2");
	});
});
