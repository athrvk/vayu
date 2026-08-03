import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		/*
		 * `node`, not `jsdom`. Spinning up a DOM costs roughly two seconds per
		 * file, and half the suite -- importers, transforms, stores, token scans,
		 * the MCP layer -- never touches one. Files that do render carry a
		 * `@vitest-environment jsdom` docblock, so the cost lands only where it
		 * buys something. A file that needs a DOM and forgets the docblock fails
		 * loudly on `document is not defined` rather than passing quietly.
		 */
		environment: "node",
		// Threads share a process, so jsdom setup is not re-paid per fork.
		pool: "threads",
		globals: true,
		setupFiles: ["./src/test/setup.ts"],
		include: ["src/**/*.test.{ts,tsx}", "electron/**/*.test.ts"],
		server: {
			deps: {
				/*
				 * `electron-store` is inlined so that `vi.mock("electron")` reaches it.
				 * An externalised dependency imports `electron` through Node directly,
				 * missing the mock registry entirely - and the real package throws
				 * "Electron failed to install correctly" outside an Electron runtime.
				 * window-state.test.ts drives the real store against a temp directory,
				 * which is the only way to test what the library does with a corrupt file.
				 */
				inline: ["graphql-language-service", "electron-store"],
			},
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			// Keep in sync with vite.config.ts - this config does not inherit it.
			"@shared": path.resolve(__dirname, "../shared"),
			graphql: path.resolve(__dirname, "./node_modules/graphql/index.js"),
		},
		dedupe: ["graphql"],
	},
});
