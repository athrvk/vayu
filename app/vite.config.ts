/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "fs";

// Read version from package.json
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, "./package.json"), "utf-8"));

export default defineConfig({
	plugins: [react()],
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
			// copy — the electron-builder / build.py icons are filesystem artifacts
			// the sandboxed web content cannot reach — but it reads them from the
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
