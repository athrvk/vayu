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
 * the jsdelivr CDN, wires the language web workers through Vite's `?worker`
 * imports, and initializes monaco-graphql (schema-less) for GraphQL parse
 * diagnostics.
 */

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { initializeMode } from "monaco-graphql/initializeMode";

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import GraphQLWorker from "monaco-graphql/esm/graphql.worker?worker";

self.MonacoEnvironment = {
	getWorker(_workerId: string, label: string) {
		switch (label) {
			case "json":
				return new JsonWorker();
			case "typescript":
			case "javascript":
				return new TsWorker();
			case "graphql":
			case "graphqlDev":
				return new GraphQLWorker();
			default:
				return new EditorWorker();
		}
	},
};

// Use the locally bundled monaco instead of fetching from the CDN.
loader.config({ monaco });

/**
 * monaco-graphql API handle. Initialized schema-less here, which provides parse
 * / syntax diagnostics, bracket matching, and formatting. A later PR can call
 * `graphqlApi.setSchemaConfig(...)` to add schema-aware autocomplete/validation
 * without touching this file's worker/loader setup.
 */
export const graphqlApi = initializeMode();
