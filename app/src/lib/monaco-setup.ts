/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Monaco setup — side-effecting module. Import once, before React renders.
 *
 * Points @monaco-editor/react at the locally bundled monaco-editor instead of
 * the jsdelivr CDN and wires the language web workers through Vite's `?worker`
 * imports.
 */

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

import { registerGraphqlProviders } from "./graphql/language-providers";

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
