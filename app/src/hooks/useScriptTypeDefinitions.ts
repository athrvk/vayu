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
import { useMonaco } from "@monaco-editor/react";
import { useScriptTypeDefinitionsQuery } from "@/queries";

/**
 * The sandbox is QuickJS plus `pm`, `console` and the two base64 globals - no
 * DOM, no Node. So the lib list is deliberately `es2022` alone: including `dom`
 * would have the editor offer `fetch`, `setTimeout` and `URL`, none of which
 * exist at runtime, and the script would fail only once it ran.
 *
 * ES2022 rather than ES2020 because the runtime is quickjs-ng, where
 * `Object.hasOwn` and `Array.prototype.at` work - targeting ES2020 would mark
 * both as errors while they run fine (see docs/engine/scripting.md).
 */
const SCRIPT_LIB = ["es2022"];

/**
 * The diagnostics a *correct* script in this editor produces, which must
 * therefore not be shown. Both follow from the editor holding a fragment while
 * the engine runs something larger.
 *
 * - **1108** - "A 'return' statement can only be used within a function body."
 *   The engine wraps every script in an IIFE before running it, so a top-level
 *   `return` to bail out early is legal and is a documented pattern.
 * - **2304** - "Cannot find name 'x'." A collection-level script part is joined
 *   to the request's (with `\n\n`) before the engine runs the result, so a name
 *   declared up there is genuinely undeclared as far as this model can see.
 *
 * Suppressing 2304 would normally cost the best diagnostic of all - `fetch` and
 * `setTimeout`, which the sandbox does not have. It does not, because the
 * engine *declares* those as `never` (see ABSENT_GLOBALS in
 * `script_types.cpp`), so calling one is "not callable" rather than "cannot
 * find name", and hover explains why.
 *
 * Narrow this list rather than widening it: every code here is a real mistake
 * going unreported in exchange for not crying wolf on correct code.
 */
const SUPPRESSED_DIAGNOSTICS = [1108, 2304];

export function useScriptTypeDefinitions() {
	const monaco = useMonaco();
	const { data } = useScriptTypeDefinitionsQuery();
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
			// quickjs-ng runs fine. `lib` below pins the library surface exactly,
			// so ESNext here costs nothing and mis-targeting would cost real
			// false errors (see docs/engine/scripting.md).
			target: monaco.typescript.ScriptTarget.ESNext,
			lib: SCRIPT_LIB,
			allowJs: true,
			// Semantic validation stays off (see setDiagnosticsOptions below), so
			// this only decides whether the worker *analyses* the model - which
			// hover and signature help both need.
			checkJs: true,
			noEmit: true,
		});

		/*
		 * Semantic validation is on, minus exactly the two diagnostics that a
		 * *correct* script in this editor produces. Both come from the same
		 * fact: the editor holds a fragment, and the engine runs something
		 * larger than what is on screen.
		 *
		 * They were found by compiling a realistic script with `tsc --checkJs`
		 * rather than guessed - see SUPPRESSED below. Everything else the worker
		 * reports is a real mistake, including the whole `pm.*` surface, so
		 * `pm.response.staus` now squiggles with a did-you-mean.
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
