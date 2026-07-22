import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./src/test/setup.ts"],
		include: ["src/**/*.test.{ts,tsx}", "electron/**/*.test.ts"],
		server: {
			deps: {
				inline: ["graphql-language-service"],
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
