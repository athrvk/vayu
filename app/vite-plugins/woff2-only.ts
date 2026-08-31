/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { Plugin } from "vite";

/**
 * A `.woff` listed after a woff2 in the same `src:`, and the file it names.
 * `@fontsource` writes every face that way for browsers older than woff2.
 */
const LEGACY_WOFF_SOURCE = /,\s*url\(([^)]+\.woff)\)\s*format\(["']woff["']\)/g;

const basename = (url: string): string => url.slice(url.lastIndexOf("/") + 1);

/**
 * Ship woff2 only.
 *
 * The `@fontsource` stylesheets give each `@font-face` two sources - the woff2,
 * then a `.woff` for browsers that predate it. The renderer is Chromium, which
 * takes the first and never asks for the second, but Vite emits every `url()` a
 * stylesheet names: importing the packages as they ship put 90 unreachable
 * files, 1.18MB, into `dist/assets`, measured by building with this plugin off.
 *
 * It works on the assembled bundle rather than in a `transform`, and that is
 * the whole design. A `transform` sees `index.css` before Vite's CSS plugin
 * inlines the `@import` tree - the font faces are not in the text yet - so a
 * `pre` transform only matches at all because `@tailwindcss/vite` happens to
 * flatten the imports first, and a `post` one is too late, the urls having
 * already become `__VITE_ASSET__` placeholders. Both make correctness a
 * property of plugin order. By `generateBundle` the CSS is final text with real
 * filenames, whoever produced it.
 *
 * Deleting a source rather than hand-writing our own `@font-face` blocks is
 * also deliberate: those blocks would copy each face's `unicode-range` into
 * this repo and stop receiving the package's corrections.
 */
export const woff2Only = (): Plugin => ({
	name: "vayu:woff2-only",
	generateBundle(_options, bundle) {
		const unreferenced = new Set<string>();

		for (const asset of Object.values(bundle)) {
			if (asset.type !== "asset" || !asset.fileName.endsWith(".css")) continue;
			const css =
				typeof asset.source === "string"
					? asset.source
					: Buffer.from(asset.source).toString();
			const stripped = css.replace(LEGACY_WOFF_SOURCE, (_match, url: string) => {
				unreferenced.add(basename(url));
				return "";
			});
			if (stripped !== css) asset.source = stripped;
		}

		if (unreferenced.size === 0) return;

		// Only drop a file nothing points at any more: a stylesheet this plugin
		// did not touch is free to name the same face, and deleting out from
		// under it would be a 404 rather than a saving.
		const stillReferenced = new Set<string>();
		for (const asset of Object.values(bundle)) {
			if (asset.type !== "asset" || !asset.fileName.endsWith(".css")) continue;
			const css =
				typeof asset.source === "string"
					? asset.source
					: Buffer.from(asset.source).toString();
			for (const name of unreferenced) if (css.includes(name)) stillReferenced.add(name);
		}

		for (const [key, asset] of Object.entries(bundle)) {
			if (asset.type !== "asset") continue;
			const name = basename(asset.fileName);
			if (unreferenced.has(name) && !stillReferenced.has(name)) delete bundle[key];
		}
	},
});
