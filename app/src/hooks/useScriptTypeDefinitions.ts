/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * useScriptTypeDefinitions Hook
 *
 * Hands Monaco's TypeScript worker the engine-generated declarations for the
 * `pm.*` surface, which is what the completion provider beside it cannot give:
 * hover documentation over an existing call, signature help while typing
 * arguments, and go-to-definition within the surface.
 *
 * Call once (in App). Monaco's language defaults are global, so one
 * registration covers every script editor instance - the same reason
 * `useScriptCompletionProvider` is called once.
 */

import { useEffect } from "react";
import { useLoadedMonaco } from "@/lib/monaco-loader";
import { useScriptTypeDefinitionsQuery } from "@/queries";

/**
 * The sandbox is QuickJS plus `pm`, `console`, the two base64 globals and the
 * timers - no DOM, no Node. So the lib list is deliberately `es2022` alone:
 * including `dom` would have the editor offer `fetch` and `URL`, neither of which
 * exists at runtime, and the script would fail only once it ran. The timers are
 * declared by the engine's own file, with the sandbox's semantics.
 *
 * ES2022 rather than ES2020 because the runtime is quickjs-ng, where
 * `Object.hasOwn` and `Array.prototype.at` work - targeting ES2020 would mark
 * both as errors while they run fine (see docs/engine/scripting.md).
 */
export const SCRIPT_LIB = ["es2022"];

/**
 * The diagnostics a *correct* script in this editor produces, which must
 * therefore not be shown.
 *
 * - **1108** - "A 'return' statement can only be used within a function body."
 *   The engine wraps every script in an async IIFE before running it, so a
 *   top-level `return` to bail out early is legal and is a documented pattern.
 * - **2304** - "Cannot find name 'x'." Two things make it fire on a script the
 *   engine runs:
 *   - an assignment to an undeclared name (`jsonData = pm.response.json()`)
 *     creates a global in the sloppy-mode IIFE, which the engine permits and
 *     `docs/engine/scripting.md` names under "Isolation between scripts";
 *   - quickjs-ng provides nine globals `lib.es2022` does not declare
 *     (`queueMicrotask`, `performance`, `DOMException`, `Float16Array`,
 *     `Iterator`, `DisposableStack`, `AsyncDisposableStack`, `SuppressedError`,
 *     `InternalError`), each of which would need declaring and holding to the
 *     runtime.
 *   The collection-level part of a script is not one of them: each script
 *   element runs in a context of its own, so a name declared there is not
 *   visible here at run time, and only the deferred load-test replay still
 *   joins `script.post` parts.
 *
 * What suppressing 2304 costs is every undeclared name drawing nothing. The
 * engine keeps the names a script is likeliest to reach for by declaring them
 * as `never` (`ABSENT_GLOBALS` in `script_types.cpp`: `fetch`, `URL`,
 * Postman's bundled `tv4` and `cheerio`), so using one is a type error with the
 * replacement on hover.
 *
 * Narrow this list rather than widening it: every code here is a real mistake
 * going unreported in exchange for not crying wolf on correct code.
 */
export const SUPPRESSED_DIAGNOSTICS = [1108, 2304];

/**
 * Everything below `strict` that decides whether a given line of a script is an
 * error. Exported as one object because a second reader exists:
 * `script-typedefs.docs-compile.test.ts` compiles the documented `pm.*` examples
 * against the engine's declarations, and it is only a guard on what the editor
 * shows if it checks them the way the editor does. Two copies of this list
 * would let the docs pass here and squiggle in the app.
 *
 * `target` is not in it - the hook takes it from Monaco's own enum; see below.
 */
export const SCRIPT_COMPILER_OPTIONS = {
	lib: SCRIPT_LIB,
	allowJs: true,
	// Semantic validation stays off in Monaco (see setDiagnosticsOptions), so
	// this only decides whether the worker *analyses* the model - which hover
	// and signature help both need.
	checkJs: true,
	noEmit: true,
	/*
	 * 3 is `ModuleDetectionKind.Force`, which Monaco's bundled enum does not
	 * export: every script is a module, not a script file in the global scope.
	 *
	 * The engine runs a script inside a function, so a top-level
	 * `const data = pm.response.json()` is local to it and shadows any global of
	 * that name. As a script file, the editor saw the same line as a second
	 * declaration of the legacy global `data` that the engine declares and
	 * reported "Cannot redeclare block-scoped variable" (2451) on correct code -
	 * and would have for `const URL` or `function fetch` (`ABSENT_GLOBALS`)
	 * already. The declarations the engine registers are a `.d.ts`, which stays
	 * a global script whatever this says.
	 *
	 * The price is TypeScript's strict-mode diagnostics on a script that runs
	 * sloppy: `with`, `delete name`, an octal literal, `yield` or `let` as a
	 * name, and a top-level `this`, which a module types as `undefined`.
	 */
	moduleDetection: 3,
	/*
	 * 99 is `ModuleKind.ESNext`, in Monaco's bundled enum and TypeScript's alike.
	 * The engine's wrapper is an *async* function (#2577), so a top-level `await`
	 * runs, and a module accepts one only under a `module` of es2022 or later
	 * (TS1378 otherwise). Nothing here imports or emits, so this decides nothing
	 * else.
	 */
	module: 99,
	/*
	 * Off deliberately, and *set* rather than left to Monaco's default: the
	 * default is what it is today, and a `getCompilerOptions()` that ever
	 * carried `strict: true` would turn this on as a side effect.
	 *
	 * The engine declares the surface's optionality truthfully
	 * (`iterationData?: { ... }`, `get(name): string | undefined`), and with
	 * this flag on the worker would report every one of those at once. Measured
	 * against the real declarations over 57 scripts - the 54 `pm.*` examples in
	 * `docs/engine/scripting.md` and `docs/app/pm-api-compatibility.md`, plus
	 * three realistic ones: 13 new diagnostics, of which **8 land on the docs'
	 * own recommended lines** (`pm.iterationData.get('username')`, correct
	 * inside the data-driven run those examples are about). Two more are on
	 * code that works: `pm.info.iteration > 0` is simply `false` outside a run,
	 * and `pm.response.errorMessage` cannot be narrowed by a truthy check on
	 * its sibling `pm.response.errorCode`.
	 *
	 * Suppressing the noise is not on offer, because the noise and the catch
	 * share a code: `18048` fires for `pm.iterationData.get(...)` - the case
	 * this was wanted for - and for `token.trim()` alike, and the remaining
	 * code is `2345`, which is the argument checking this whole feature exists
	 * to provide.
	 *
	 * So the guard the docs recommend stays advice rather than a rule. This is
	 * the same trade SUPPRESSED_DIAGNOSTICS makes above, one level up: a real
	 * mistake goes unreported in exchange for not crying wolf on correct code.
	 * See issue #443.
	 */
	strictNullChecks: false,
};

export function useScriptTypeDefinitions() {
	// Passive by design: null until an editor has loaded Monaco, so registration
	// happens then. `@monaco-editor/react`'s `useMonaco` would load it from here,
	// at startup, and from the CDN - see `lib/monaco-loader.ts` (#1146).
	const monaco = useLoadedMonaco();
	// Same gate as `useScriptCompletionProvider`: nothing reads the
	// declarations until Monaco has loaded, so neither is fetched at launch.
	const { data } = useScriptTypeDefinitionsQuery({ enabled: monaco !== null });
	const typeDefinitions = data?.typeDefinitions;
	const libUri = data?.libUri;

	useEffect(() => {
		if (!monaco || !typeDefinitions) return;

		// The top-level `typescript` namespace, not `languages.typescript` - the
		// latter is deprecated in this Monaco version and typed as a stub.
		const defaults = monaco.typescript.javascriptDefaults;

		defaults.setCompilerOptions({
			...defaults.getCompilerOptions(),
			// Monaco's bundled enum stops at ES2020, and ES2020 would flag syntax
			// quickjs-ng runs fine. `lib` in SCRIPT_COMPILER_OPTIONS pins the
			// library surface exactly, so ESNext here costs nothing and
			// mis-targeting would cost real false errors (see
			// docs/engine/scripting.md).
			target: monaco.typescript.ScriptTarget.ESNext,
			...SCRIPT_COMPILER_OPTIONS,
		});

		/*
		 * Semantic validation is on, minus exactly the two diagnostics that a
		 * *correct* script in this editor produces - see SUPPRESSED_DIAGNOSTICS
		 * for which and why. Everything else the worker reports is a real
		 * mistake, including the whole `pm.*` surface, so `pm.response.staus`
		 * squiggles with a did-you-mean.
		 */
		defaults.setDiagnosticsOptions({
			noSemanticValidation: false,
			noSyntaxValidation: false,
			noSuggestionDiagnostics: false,
			diagnosticCodesToIgnore: SUPPRESSED_DIAGNOSTICS,
		});

		/*
		 * Every one of these defaults to true in Monaco today, so this call
		 * changes nothing right now - it pins the intent. Diagnostics are what
		 * make the rest useful (a quick fix is offered against an error, and
		 * rename/references need the same analysis), and they arrived together;
		 * a future default flipping off would remove them silently.
		 */
		defaults.setModeConfiguration({
			...defaults.modeConfiguration,
			diagnostics: true,
			hovers: true,
			codeActions: true, // "Did you mean 'status'?" as an applicable fix
			definitions: true,
			references: true,
			rename: true,
			documentHighlights: true,
			signatureHelp: true,
			completionItems: true,
		});

		const disposable = defaults.addExtraLib(typeDefinitions, libUri ?? "ts:vayu/pm.d.ts");
		return () => disposable.dispose();
	}, [monaco, typeDefinitions, libUri]);
}
