/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Monaco's JSON worker as a module, which `monaco-editor` ships untyped. Declared so
 * `variables-diagnostics.test.ts` validates against the real language service (it decides which
 * squiggles the Variables pane paints), not a stub. A monaco upgrade that moves the module fails
 * the import; one that changes these signatures does not, so declare only what the test calls.
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
