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
			/*
			 * The ESM entry specifically. graphql 17 ships both builds, and its
			 * dev build refuses a type built by another copy of itself
			 * ("Cannot use GraphQLScalarType ... from another module or realm").
			 * `graphql-language-service` is inlined above, so its own import
			 * resolves to `index.mjs`; pointing this at `index.js` handed the app
			 * side the CommonJS copy and every schema object crossing into the
			 * language service failed that check. `dedupe` alone does not settle
			 * it - one package, two builds, is not a duplicate it can collapse.
			 */
			graphql: path.resolve(__dirname, "./node_modules/graphql/index.mjs"),
		},
		dedupe: ["graphql"],
	},
});
