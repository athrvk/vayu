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
		 * Diagnostics are deliberately off.
		 *
		 * A script editor holds a *fragment* - the engine wraps it in an IIFE
		 * before running it - and the two fragments of one request are separate
		 * models that cannot see each other's declarations. Turning semantic
		 * validation on would squiggle correct scripts (a `const` a
		 * post-request script reads from a pre-request one reads as undefined)
		 * and there is no model-per-request wiring here to fix that with.
		 *
		 * Everything the declarations are actually wanted for - hover text,
		 * signature help, completion detail - is produced by the worker without
		 * diagnostics. Flip `noSemanticValidation` once fragments share a model
		 * per request; the declarations are ready for it (they compile clean
		 * under --strict, and correctly reject `pm.response.staus`).
		 */
		defaults.setDiagnosticsOptions({
			noSemanticValidation: true,
			noSyntaxValidation: false,
			noSuggestionDiagnostics: false,
		});

		const disposable = defaults.addExtraLib(typeDefinitions, libUri ?? "ts:vayu/pm.d.ts");
		return () => disposable.dispose();
	}, [monaco, typeDefinitions, libUri]);
}
