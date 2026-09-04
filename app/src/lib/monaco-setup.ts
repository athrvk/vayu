/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Monaco setup - side-effecting module. Importing it composes and configures
 * Monaco once.
 *
 * Points @monaco-editor/react at the locally bundled monaco-editor instead of
 * the jsdelivr CDN and wires the language web workers through Vite's `?worker`
 * imports.
 *
 * **Nothing imports this statically.** It pulls in the editor and, through the
 * GraphQL providers, `graphql-language-service` - the bulk of what used to be a
 * 5.5MB entry chunk parsed before the window could appear (#1146).
 * `lib/monaco-loader.ts` is the one importer, dynamically, the first time an
 * editor is about to mount; the `monaco` export below is how it hands the
 * configured instance to the rest of the app.
 *
 * **The entry is composed here rather than taken from the package root**
 * (#1147). `import * as monaco from "monaco-editor"` is the full barrel: every
 * Monarch grammar monaco ships, all four language services, and an LSP client.
 * Two of those services - CSS and HTML - reach their workers through
 * `new Worker(new URL("css.worker.js", import.meta.url))` in monaco's own
 * `workerManager`, so the build emitted `css.worker` (1.0MB) and `html.worker`
 * (0.7MB) into every installer even though `getWorker` below never constructs
 * either, alongside ~85 grammars for languages nothing here can put in a model.
 * The imports are therefore spelled out: the editor core, the two language
 * services the app drives, and one grammar per language id it can actually
 * open. `lib/monaco-api.ts` records what that leaves out and why.
 *
 * **The entry points are 0.56's, not the `esm/vs/...` paths** (#1342). 0.56
 * publishes an `exports` map (`"./*": "./esm/vs/*.js"`), so a specifier that
 * spells `esm/vs` itself now resolves to `esm/vs/esm/vs/...` and fails. What
 * replaces those paths is the package's own supported surface - `editor`,
 * `features/<feature>/register`, `languages/definitions/<language>/register`
 * and `languages/features/<service>/register` - which is what every import
 * below uses. The composition is otherwise the same one #1147 arrived at.
 */

import { loader } from "@monaco-editor/react";

// The API surface, and separately the standalone editor's contributions. This
// pair is what the package root is built from, minus the languages: `editor`
// is types and namespaces *only*, so on its own the editor mounts with no find
// widget, no folding, no bracket matching, and no suggest, hover or
// context-menu widgets - all of which the editors here use.
// `features/register.all` registers them against the same `editor` instances,
// so importing it for its side effects leaves `editorApi` below unchanged.
//
// It is the successor to 0.55's `edcore.main`, and three contributions
// `edcore.main` carried are not on it: `caretOperations` (the two keybindingless
// Move Caret actions), `copyPasteContribution` and `documentSemanticTokens`.
// Each needs a provider registered to do anything - a paste provider, a
// document semantic-tokens provider - and this app registers none of the three,
// nor names those actions in `constants/shortcuts.ts`. `viewportSemanticTokens`,
// which is what a live editor actually tokenizes through, is on `register.all`.
import * as editorApi from "monaco-editor/editor";
import "monaco-editor/features/register.all";

// The two language services the app drives from the main thread, and the only
// two whose workers `getWorker` constructs: `useScriptTypeDefinitions` feeds
// `typescript.javascriptDefaults`, and `graphql/variables-schema` feeds
// `json.jsonDefaults`.
import * as jsonLanguage from "monaco-editor/languages/features/json/register";
import * as typescriptLanguage from "monaco-editor/languages/features/typescript/register";

// One Monarch grammar per language id the app can put in a model. The response
// viewer maps body types to css/html/markdown/xml/json/javascript/plaintext
// (`response-viewer/utils.ts`), the body and script editors open json, xml,
// javascript and graphql, and plaintext needs no grammar. `graphql` is monaco's
// own basic language - the providers in `graphql/language-providers.ts` attach
// to that registered id, so dropping the grammar would leave a graphql model
// tokenized, and matched, as plain text. `http` is ours, registered below.
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/graphql/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/xml/register";

import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";

import type { MonacoApi } from "./monaco-api";
import { registerGraphqlProviders } from "./graphql/language-providers";
import { registerHttpLanguage } from "./http-language";
import { registerMonacoTheme } from "./monaco-theme";

/**
 * The composed namespace, in the shape the package root exports. Annotated
 * with `MonacoApi` so the pieces are checked against monaco's own types: the
 * language services sit at the top level (`monaco.typescript`, `monaco.json`),
 * where the barrel puts them and where the call sites read them.
 */
const monaco: MonacoApi = {
	...editorApi,
	// No cast: 0.55 shipped these two subpaths with an empty declaration stub
	// (`monaco.contribution.d.ts` was literally `export {}`) and the real types
	// only inlined in the barrel, so both had to be forced into place. 0.56's
	// `register.d.ts` is the barrel's own source for `json` and `typescript`,
	// so the two sides are the same type and assign directly (#1342).
	// `monaco-setup.contributions.test.ts` still asserts at runtime that each
	// module exports what the call sites read.
	json: jsonLanguage,
	typescript: typescriptLanguage,
};

self.MonacoEnvironment = {
	getWorker(_workerId: string, label: string) {
		switch (label) {
			case "json":
				return new JsonWorker();
			case "typescript":
			case "javascript":
				return new TsWorker();
			default:
				return new EditorWorker();
		}
	},
};

// Use the locally bundled monaco instead of fetching from the CDN.
loader.config({ monaco });

registerGraphqlProviders(monaco);
// The Raw tab asks for `http`; Monaco ships no such language, so it is ours.
registerHttpLanguage(monaco);
/*
 * The app's own theme, before any editor exists (#1321). An editor created
 * with a theme name Monaco does not know falls back to `vs` and stays there -
 * a later `defineTheme` re-applies only the theme already showing - so this
 * registration has to precede the first `editor.create`, which is why it is
 * here and not in a React effect. `useMonacoTheme` keeps it in step after that.
 */
registerMonacoTheme(monaco);

/**
 * The configured instance, for callers that need Monaco's own APIs (the
 * completion and type-definition providers registered from `App`). Exported
 * rather than re-imported from `monaco-editor` at each call site so that
 * holding it always means the configuration above has run.
 */
export { monaco };
