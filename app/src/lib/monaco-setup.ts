/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Monaco setup - side-effecting module. Importing it configures Monaco once.
 *
 * Points @monaco-editor/react at the locally bundled monaco-editor instead of
 * the jsdelivr CDN and wires the language web workers through Vite's `?worker`
 * imports.
 *
 * **Nothing imports this statically.** It pulls the whole monaco-editor barrel
 * and, through the GraphQL providers, `graphql-language-service` - the bulk of
 * what used to be a 5.5MB entry chunk parsed before the window could appear
 * (#1146). `lib/monaco-loader.ts` is the one importer, dynamically, the first
 * time an editor is about to mount; the `monaco` export below is how it hands
 * the configured instance to the rest of the app.
 */

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

import { registerGraphqlProviders } from "./graphql/language-providers";
import { registerHttpLanguage } from "./http-language";

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
