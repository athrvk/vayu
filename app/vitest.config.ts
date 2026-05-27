import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./src/test/setup.ts"],
		include: ["src/**/*.test.{ts,tsx}"],
		server: {
			deps: {
				inline: ["graphql-language-service"],
			},
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			graphql: path.resolve(__dirname, "./node_modules/graphql/index.js"),
		},
		dedupe: ["graphql"],
	},
});
