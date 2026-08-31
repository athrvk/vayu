/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { woff2Only } from "./vite-plugins/woff2-only";
import path from "path";
import { readFileSync } from "fs";

// Read version from package.json
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, "./package.json"), "utf-8"));

export default defineConfig({
	// Tailwind v4 runs as a Vite plugin, not a PostCSS plugin. As a PostCSS
	// plugin it injected generated declarations with no `source.input.file`,
	// which tripped Vite's own url-rewrite plugin into warning "did not pass the
	// `from` option to `postcss.parse`" on every dev CSS transform. As a Vite
	// plugin its output is re-parsed with a real `from`, so no fromless nodes.
	// Autoprefixer stays in postcss.config.cjs, so vendor prefixing is unchanged.
	// `woff2Only` drops the legacy `.woff` sibling `@fontsource` names next to
	// every woff2 - 90 files, 1.18MB, that Chromium never asks for. See the
	// plugin for why it works on the bundle rather than in a transform.
	plugins: [react(), tailwindcss(), woff2Only()],
	define: {
		__VAYU_VERSION__: JSON.stringify(packageJson.version),
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@/components": path.resolve(__dirname, "./src/components"),
			"@/modules": path.resolve(__dirname, "./src/modules"),
			"@/stores": path.resolve(__dirname, "./src/stores"),
			"@/hooks": path.resolve(__dirname, "./src/hooks"),
			"@/services": path.resolve(__dirname, "./src/services"),
			"@/types": path.resolve(__dirname, "./src/types"),
			"@/utils": path.resolve(__dirname, "./src/utils"),
			// Repo-level shared assets (icons). The renderer needs its own bundled
			// copy - the electron-builder / build.py icons are filesystem artifacts
			// the sandboxed web content cannot reach - but it reads them from the
			// canonical source here rather than a duplicate under src/.
			"@shared": path.resolve(__dirname, "../shared"),
		},
	},
	base: "./",
	server: {
		port: 5173,
		strictPort: true,
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		// **No `rolldownOptions.output.codeSplitting` groups, deliberately**
		// (#1147). What defers a chunk here is a dynamic import - `React.lazy`
		// on the tab surfaces, `ensureMonaco()` on the editor (#1146) - never a
		// manual group, and in a packaged app loading from asar there is no
		// cross-release HTTP cache for a vendor chunk to hit either. The two
		// groups that used to sit here (`react-vendor`, `charts`/uplot) were
		// measured against rolldown's own chunking and moved nothing: same 132
		// chunks, same 14.9MB total, same modules behind the same lazy
		// boundaries. Adding one for monaco was worse than inert - the named
		// group turned the 3.7MB editor chunk into a `modulepreload` in
		// `index.html`, putting back on the startup path exactly what #1146
		// took off it. Measure before adding a group here, and measure
		// `dist/index.html`'s preload list, not just chunk sizes.
	},
});
