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
 * (#1147). `import * as monaco from "monaco-editor"` is `editor.main`: every
 * Monarch grammar monaco ships, all four language services, and an LSP client.
 * Two of those services - CSS and HTML - reach their workers through
 * `new Worker(new URL("css.worker.js", import.meta.url))` in monaco's own
 * `workerManager`, so the build emitted `css.worker` (1.0MB) and `html.worker`
 * (0.7MB) into every installer even though `getWorker` below never constructs
 * either, alongside ~85 grammars for languages nothing here can put in a model.
 * The imports are therefore spelled out: the editor core, the two language
 * services the app drives, and one grammar per language id it can actually
 * open. `lib/monaco-api.ts` records what that leaves out and why.
 */

import { loader } from "@monaco-editor/react";

// The API surface, and separately the standalone editor's contributions. This
// pair is what the package root's `editor.main` is built from, minus the
// languages: `editor.api` is types and namespaces *only*, so on its own the
// editor mounts with no find widget, no folding, no bracket matching, and no
// suggest, hover or context-menu widgets - all of which the editors here use.
// `edcore.main` registers them and re-exports the same `editor.api` instances,
// so importing it for its side effects leaves `editorApi` below unchanged.
import * as editorApi from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/editor/edcore.main.js";

// The two language services the app drives from the main thread, and the only
// two whose workers `getWorker` constructs: `useScriptTypeDefinitions` feeds
// `typescript.javascriptDefaults`, and `graphql/variables-schema` feeds
// `json.jsonDefaults`.
import * as jsonLanguage from "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import * as typescriptLanguage from "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";

// One Monarch grammar per language id the app can put in a model. The response
// viewer maps body types to css/html/markdown/xml/json/javascript/plaintext
// (`response-viewer/utils.ts`), the body and script editors open json, xml,
// javascript and graphql, and plaintext needs no grammar. `graphql` is monaco's
// own basic language - the providers in `graphql/language-providers.ts` attach
// to that registered id, so dropping the grammar would leave a graphql model
// tokenized, and matched, as plain text. `http` is ours, registered below.
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

import type { MonacoApi } from "./monaco-api";
import { registerGraphqlProviders } from "./graphql/language-providers";
import { registerHttpLanguage } from "./http-language";

/**
 * The composed namespace, in the shape the package root exports. Annotated
 * with `MonacoApi` so the pieces are checked against monaco's own types: the
 * language services sit at the top level (`monaco.typescript`, `monaco.json`),
 * where the barrel puts them and where the call sites read them.
 */
const monaco: MonacoApi = {
	...editorApi,
	// Monaco ships these two subpaths with an empty declaration stub
	// (`monaco.contribution.d.ts` is literally `export {}`); the real types for
	// both namespaces live inlined in `editor.main.d.ts`, which is what
	// `MonacoApi` reads. That mismatch is all the cast covers - the members the
	// app then reads are still monaco's own types, and
	// `monaco-setup.contributions.test.ts` asserts at runtime that each module
	// really does export what the cast promises.
	json: jsonLanguage as unknown as MonacoApi["json"],
	typescript: typescriptLanguage as unknown as MonacoApi["typescript"],
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

/**
 * The configured instance, for callers that need Monaco's own APIs (the
 * completion and type-definition providers registered from `App`). Exported
 * rather than re-imported from `monaco-editor` at each call site so that
 * holding it always means the configuration above has run.
 */
export { monaco };
