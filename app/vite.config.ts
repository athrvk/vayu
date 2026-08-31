/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { readFileSync } from "fs";

// Read version from package.json
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, "./package.json"), "utf-8"));

/**
 * Drop the legacy `.woff` source from the `@fontsource` stylesheets.
 *
 * Each of their `@font-face` rules lists woff2 first and a `.woff` after it for
 * browsers that predate woff2. Chromium takes the woff2 and never asks for the
 * sibling - but Vite emits every `url()` a stylesheet names, so importing the
 * packages as they ship put 90 unreachable files (1.18MB) in `dist/assets`,
 * measured by building with this plugin off.
 *
 * Stripping the second source here rather than hand-writing our own
 * `@font-face` blocks is deliberate: those blocks would copy each face's
 * `unicode-range` into this repo and stop receiving the package's corrections.
 * The rule is matched on the `url()` itself, not on the module id, because the
 * `@import`s are already inlined into `index.css` by the time any plugin sees
 * it.
 */
const woff2Only = {
	name: "vayu:woff2-only",
	enforce: "pre" as const,
	transform(code: string, id: string) {
		if (!id.split("?")[0].endsWith(".css")) return null;
		const stripped = code.replace(
			/,\s*url\(([^)]*@fontsource[^)]*)\.woff\)\s*format\(["']woff["']\)/g,
			""
		);
		return stripped === code ? null : stripped;
	},
};

export default defineConfig({
	// Tailwind v4 runs as a Vite plugin, not a PostCSS plugin. As a PostCSS
	// plugin it injected generated declarations with no `source.input.file`,
	// which tripped Vite's own url-rewrite plugin into warning "did not pass the
	// `from` option to `postcss.parse`" on every dev CSS transform. As a Vite
	// plugin its output is re-parsed with a real `from`, so no fromless nodes.
	// Autoprefixer stays in postcss.config.cjs, so vendor prefixing is unchanged.
	plugins: [react(), tailwindcss(), woff2Only],
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
		// Vite 8 / Rolldown: rolldownOptions replaces rollupOptions, and
		// manualChunks is replaced by codeSplitting.groups (test matches the
		// module id; [\\/] keeps it cross-platform for Windows CI builds).
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [
						{
							name: "react-vendor",
							test: /node_modules[\\/](react|react-dom)[\\/]/,
							priority: 20,
						},
						{
							name: "charts",
							test: /node_modules[\\/]uplot[\\/]/,
							priority: 15,
						},
					],
				},
			},
		},
	},
});
