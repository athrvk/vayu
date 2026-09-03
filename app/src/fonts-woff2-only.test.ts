/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The `.woff` files must not reach `dist/`.
 *
 * `@fontsource` gives every `@font-face` a woff2 and then a `.woff` for
 * browsers that predate it. Chromium takes the first and never asks for the
 * second, but Vite emits every `url()` a stylesheet names, so without
 * `woff2Only` the build ships 90 files - 1.18MB - that nothing can reach
 * (#1149).
 *
 * This runs a real Vite build over one `@import`, because the mistake this
 * guards is not in the regex. An earlier version of the plugin did the same
 * substitution in a `transform`, which matched only because
 * `@tailwindcss/vite` had already flattened the `@import` tree in the app's own
 * config: on any pipeline without it - a fixture like this one, or a future
 * Vite whose CSS plugin inlines differently - the hook saw `@import
 * "./fonts.css";` and nothing else, stripped nothing, and every test stayed
 * green while the 1.18MB came back. So the assertion is on emitted files, and
 * the fixture deliberately does not load the rest of the app's plugins.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { build } from "vite";

import { woff2Only } from "../vite-plugins/woff2-only";

const appRoot = path.resolve(__dirname, "..");

/** One family is enough: every `@fontsource` face is written the same way. */
const FIXTURE_IMPORT = '@import "@fontsource/inter/400.css";\n';

interface BuildResult {
	files: string[];
	css: string;
}

const buildFixture = async (plugins: ReturnType<typeof woff2Only>[]): Promise<BuildResult> => {
	const root = mkdtempSync(path.join(tmpdir(), "vayu-woff2-"));
	const entry = path.join(root, "entry.css");
	writeFileSync(entry, FIXTURE_IMPORT);
	const outDir = path.join(root, "out");

	await build({
		root,
		logLevel: "silent",
		// The fixture lives outside the app, so point the bare specifier at the
		// app's own installed packages rather than copying font files around.
		resolve: { alias: { "@fontsource": path.join(appRoot, "node_modules/@fontsource") } },
		plugins,
		build: { outDir, rollupOptions: { input: entry } },
	});

	const assets = path.join(outDir, "assets");
	const files = readdirSync(assets);
	const cssFile = files.find((f) => f.endsWith(".css"));
	expect(cssFile).toBeDefined();
	return { files, css: readFileSync(path.join(assets, cssFile as string), "utf8") };
};

describe("the built font assets", () => {
	let withPlugin: BuildResult;
	let withoutPlugin: BuildResult;

	beforeAll(async () => {
		withPlugin = await buildFixture([woff2Only()]);
		withoutPlugin = await buildFixture([]);
	}, 60_000);

	it("carry the woff2 of every face", () => {
		// Guards the assertions below against a fixture that emitted nothing.
		expect(withPlugin.files.filter((f) => f.endsWith(".woff2")).length).toBeGreaterThan(0);
		expect(withPlugin.files.filter((f) => f.endsWith(".woff2"))).toEqual(
			withoutPlugin.files.filter((f) => f.endsWith(".woff2"))
		);
	});

	it("carry no legacy .woff, which the plugin is the only reason for", () => {
		expect(withPlugin.files.filter((f) => f.endsWith(".woff"))).toEqual([]);
		// The same build without it, so the guard fails loudly rather than
		// passing on a fixture that never had a `.woff` to begin with.
		expect(withoutPlugin.files.filter((f) => f.endsWith(".woff")).length).toBeGreaterThan(0);
	});

	it("leave no stylesheet pointing at a file that is gone", () => {
		expect(withPlugin.css).not.toMatch(/url\([^)]+\.woff\)/);
		const referenced = [...withPlugin.css.matchAll(/url\(([^)]+\.woff2)\)/g)].map((m) =>
			m[1].slice(m[1].lastIndexOf("/") + 1)
		);
		expect(referenced.length).toBeGreaterThan(0);
		for (const file of referenced) expect(withPlugin.files).toContain(file);
	});
});
