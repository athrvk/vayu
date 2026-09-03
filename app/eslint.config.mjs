import js from "@eslint/js";
import typescript from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";
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

	// Accessibility: the mechanical net under the behavioural guards (#1216).
	// Every a11y rule this repository enforced before now was a bespoke test of
	// one past incident - a real accessible name on icon buttons, a focus reveal
	// beside every hover reveal - which catches the defect that already happened
	// and nothing else. `jsx-a11y` recommended is the general case: it costs no
	// workflow (`pnpm lint` already gates PRs), no runtime and no flake.
	//
	// Scoped to `.tsx`, which is where JSX lives; the plugin's own
	// `languageOptions` only re-declare the JSX parser feature already set above.
	//
	// The baseline the recommended set found was 58 errors, not the four #1216
	// predicted from reading. Every one was read: three were real (they are
	// fixed), and the rest are two patterns the rules cannot see, suppressed at
	// the line with the reason - except where the rule takes an option that
	// teaches it the pattern once, which is these three. The allowlist is
	// documented under "Accessibility" in docs/design-system.md.
	{
		files: ["**/*.tsx"],
		plugins: jsxA11y.flatConfigs.recommended.plugins,
		rules: {
			...jsxA11y.flatConfigs.recommended.rules,

			// 14 sites, every one a field inside a dialog, a rename box opened over
			// a row, or the command palette - where moving focus into the thing the
			// user just opened is the WAI-ARIA dialog pattern, not the page-load
			// autofocus this rule exists to prevent. Off here rather than suppressed
			// fourteen times, the same call `no-console` gets for `electron/`.
			"jsx-a11y/no-autofocus": "off",

			// The rule recognises a nested control by lower-case tag name, so it
			// cannot see that `Switch`, `Input` and `SelectTrigger` each render one
			// native labelable element and nothing else - the association it asks
			// for is already there. Naming them is what the option is for.
			"jsx-a11y/label-has-associated-control": [
				"error",
				{ controlComponents: ["Switch", "Input", "SelectTrigger"] },
			],

			// `separator` is structural in the ARIA role table, but the window
			// splitter - a focusable `role="separator"` with arrow/Page/Home/End
			// keys - is the sanctioned interactive form of it, and both resize
			// handles here implement exactly that. `tabpanel` is the rule's own
			// default, kept.
			"jsx-a11y/no-noninteractive-tabindex": [
				"error",
				{ tags: [], roles: ["tabpanel", "separator"], allowExpressionValues: true },
			],
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
