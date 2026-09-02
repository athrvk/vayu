// ESLint for the first-party JavaScript that lives OUTSIDE `app/` - today the
// two perf harnesses under `scripts/perf/`, tomorrow whatever else lands under
// `scripts/` or `.github/`. Until #1166 those files were checked by nothing:
// ESLint is scoped to `app/`, prettier's domain is `app/` by policy, and the
// `Script lint` job covers shell and Python only.
//
// `app/eslint.config.mjs` cannot grow a block for them. Flat config resolves
// `files` patterns against the base path and forbids patterns that climb out of
// it with `..`, so a pattern written there always means "under `app/`" - which
// is why that file's own `scripts/**` block matches `app/scripts/`, not this
// repository's `scripts/`.
//
// This config lives in `app/` even though it describes the tree above it,
// because the two halves resolve from different places: ESLint loads a config
// as an ES module, so `@eslint/js` and `globals` below resolve from this file's
// directory upwards, and `app/node_modules` is the only place in the repository
// where ESLint is installed - while the `files` patterns are matched against
// the base path, which is the working directory ESLint runs in. Run it from the
// repository root and the patterns below mean what they say:
//
//   app/node_modules/.bin/eslint --config app/eslint.repo-js.config.mjs <files>
//
// No TypeScript, React or Prettier plugin, deliberately: these are plain Node
// scripts with no tsc behind them and no prettier over them.

import js from "@eslint/js";
import globals from "globals";

export default [
	// Everything ESLint is handed comes from the caller's file list, but a stray
	// invocation (`eslint .` from the root, an editor's on-save run) must not
	// wander into the app's own tree - which has its own config - or into
	// vendored upstream sources, which are not ours to keep clean. Same rule the
	// shell and Python scans apply with `grep -v '^engine/vendor/'`.
	{
		ignores: ["app/**", "engine/vendor/**", "**/node_modules/**"],
	},

	js.configs.recommended,

	// `.mjs` is ESM by extension, whatever a package.json says. There is no
	// package.json outside `app/`, so `.js` is CommonJS by Node's own rule -
	// a file that wants ESM out here has to be named `.mjs` to run at all, and
	// parsing it as anything else would be a lie about how Node loads it.
	//
	// The two global tables differ for the same reason: `globals.node` includes
	// `require`, `module`, `exports` and `__dirname`, which an ES module does not
	// have - `require("node:fs")` in a `.mjs` is a `ReferenceError` the moment
	// Node loads it, and handing that block the CommonJS table would have
	// `no-undef` bless it. `globals.nodeBuiltin` is the same table without them.
	{
		files: ["**/*.mjs"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: globals.nodeBuiltin,
		},
	},
	{
		files: ["**/*.cjs", "**/*.js"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "commonjs",
			globals: globals.node,
		},
	},
];
