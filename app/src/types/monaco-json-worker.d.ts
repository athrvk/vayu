/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Monaco's JSON worker, as a module rather than as a worker.
 *
 * `monaco-editor` ships the class untyped - the package's own types describe the
 * editor API, not the code that runs inside its workers. It is declared here so
 * `variables-diagnostics.test.ts` can validate against the real language service
 * rather than a stub of it: the worker is what decides which squiggles the
 * Variables pane paints, and only a small, honest slice of its surface is used.
 *
 * A monaco upgrade that moves or renames the module fails the *import*, which is
 * loud. A monaco upgrade that changes these signatures does not - so keep this
 * to what the test calls, and nothing wider.
 */
declare module "monaco-editor/languages/features/json/jsonWorker.js" {
	interface MirrorModel {
		uri: { toString: () => string };
		getValue: () => string;
	}

	interface WorkerContext {
		getMirrorModels: () => MirrorModel[];
	}

	interface CreateData {
		languageId: string;
		languageSettings: {
			validate: boolean;
			allowComments: boolean;
			enableSchemaRequest: boolean;
			schemas: { uri: string; fileMatch?: string[]; schema: unknown }[];
		};
	}

	/** An LSP diagnostic: 0-based positions, unlike Monaco's markers. */
	interface JsonDiagnostic {
		message: string;
		range: {
			start: { line: number; character: number };
			end: { line: number; character: number };
		};
	}

	export class JSONWorker {
		constructor(ctx: WorkerContext, createData: CreateData);
		doValidation(uri: string): Promise<JsonDiagnostic[]>;
	}
}
