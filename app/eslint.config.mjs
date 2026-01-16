import js from "@eslint/js";
import typescript from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

export default [
	// Base JavaScript config
	js.configs.recommended,

	// Global ignores
	{
		ignores: [
			"dist/**",
			"dist-electron/**",
			"build/**",
			"node_modules/**",
			"*.config.js",
			"*.config.mjs",
			"*.config.cjs",
			"vite.config.d.ts",
		],
	},

	// TypeScript files
	{
		files: ["**/*.{ts,tsx}"],
		languageOptions: {
			parser: typescriptParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
				ecmaFeatures: {
					jsx: true,
				},
			},
		},
		plugins: {
			"@typescript-eslint": typescript,
			"react-hooks": reactHooks,
			"react-refresh": reactRefresh,
			prettier: prettier,
		},
		rules: {
			...typescript.configs.recommended.rules,
			...reactHooks.configs.recommended.rules,
			"react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
				},
			],
			"prettier/prettier": "error",
		},
	},

	// Prettier config (must be last to override other configs)
	prettierConfig,
];
