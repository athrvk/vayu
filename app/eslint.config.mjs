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
			// TypeScript's compiler already reports use of undefined variables, and
			// `no-undef` cannot see TS lib / DOM / Node global types, so on .ts/.tsx
			// it only produces false positives. Disabling it is the typescript-eslint
			// recommendation. (Enabled globally via js.configs.recommended above.)
			"no-undef": "off",
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

	// Node build/dev scripts: plain ESM run by Node (not type-checked by tsc),
	// so they legitimately use Node globals (process, __dirname, setImmediate…).
	// `no-undef` has no global table for them here, so scope it off rather than
	// enumerate Node globals (the sole file is scripts/electron-dev.mjs).
	{
		files: ["scripts/**/*.{mjs,cjs,js}"],
		languageOptions: {
			sourceType: "module",
		},
		rules: {
			"no-undef": "off",
		},
	},

	// Prettier config (must be last to override other configs)
	prettierConfig,
];
