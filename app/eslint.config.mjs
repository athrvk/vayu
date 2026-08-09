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
			// Debug logging is not a renderer feature. 21 `console.log` calls had
			// accumulated before anyone counted (#428), three of them dumping whole
			// stored requests - auth headers, tokens and scripts - into DevTools.
			// `warn`/`error` stay: they report states a user may need to report
			// back. The rule flags calls, not string literals, so the `console.log`
			// inside a generated code snippet (services/codegen) is unaffected.
			"no-console": ["error", { allow: ["warn", "error"] }],
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

	// Main process: its console IS the app's log. `electron/` runs in Node and
	// writes to the terminal the user launched Vayu from - the sidecar's engine
	// lifecycle, the lock-file recovery, the updater's disabled-in-dev line.
	// That output is diagnosed from, not left-over debug chatter, so `no-console`
	// is off here rather than suppressed 35 times. The renderer keeps the rule:
	// its console is DevTools, which nobody reads and everybody ships.
	{
		files: ["electron/**/*.{ts,tsx}"],
		rules: {
			"no-console": "off",
		},
	},

	// Prettier config (must be last to override other configs)
	prettierConfig,
];
