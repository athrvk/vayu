/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { VariableValue } from "@/types";
import type { EnvironmentDraft, ImportOptions, ImportParser, ImportResult } from "./types";
import { asString, toVarRecord } from "./shared";

/**
 * Postman exports an environment as its own file, separate from the collection
 * export - which is why `postman.ts` correctly returns `environments: []`. This
 * parser reads that separate file.
 *
 * It claims both variable scopes Postman writes in this shape:
 *
 * - `"environment"` → one `EnvironmentDraft`, created like any other environment.
 * - `"globals"`     → `ImportResult.globals`, merged into Vayu's globals scope.
 *
 * They share a document shape and therefore a parser, so the mapping rules
 * (secret flag, enabled precedence, `{{ var }}` normalisation) cannot drift
 * between them. Only the destination differs.
 *
 * Either way the result has no collections at all, the only parser that produces
 * that. `ImportOrchestrator.run` already handles it (its collection loop simply
 * does not execute), and `ImportModal` blocks the import when nothing would be
 * created rather than closing on a no-op.
 */

/** Postman's marker for a globals export; an environment export says `"environment"`. */
const GLOBALS_SCOPE = "globals";
const ENVIRONMENT_SCOPE = "environment";

export class PostmanEnvironmentParser implements ImportParser {
	// Registry label. The *user-facing* format is per-document (`meta.format`
	// below), since one parser now covers two exports that read differently.
	readonly formatName = "Postman Environment";
	readonly formatKey = "postman-environment";

	detect(parsed: unknown, _raw: string): boolean {
		const p = parsed as { _postman_variable_scope?: unknown; values?: unknown } | null;
		const scope = p?._postman_variable_scope;
		return (scope === ENVIRONMENT_SCOPE || scope === GLOBALS_SCOPE) && Array.isArray(p?.values);
	}

	parse(parsed: unknown, _raw: string, opts: ImportOptions): ImportResult {
		const p = parsed as { name?: unknown; values?: unknown; _postman_variable_scope?: unknown };
		const isGlobals = p._postman_variable_scope === GLOBALS_SCOPE;

		// Gated at parse time, matching InsomniaV4Parser: with the option off the
		// draft carries nothing and the counts report 0, so the preview shows what
		// will actually be created. The one toggle covers both scopes - it reads
		// "Import environments & variables", and globals are variables.
		const variables: Record<string, VariableValue> = opts.importEnvironments
			? toVarRecord((p.values ?? []) as Parameters<typeof toVarRecord>[0])
			: {};

		const environments: EnvironmentDraft[] =
			isGlobals || !opts.importEnvironments
				? []
				: [
						{
							name: asString(p.name) || "Imported Environment",
							description: "",
							variables,
						},
					];
		// A globals export carries a `name` too (the workspace's), but Vayu's globals
		// scope is a singleton with nowhere to put it, so it is dropped rather than
		// invented into an environment name.
		const globals = isGlobals ? variables : {};

		return {
			collections: [],
			environments,
			globals,
			meta: {
				format: isGlobals ? "Postman Globals" : this.formatName,
				requestCount: 0,
				folderCount: 0,
				environmentCount: environments.length,
				globalCount: Object.keys(globals).length,
				// An environment/globals export has no requests, so no examples.
				exampleCount: 0,
				skipped: [],
				nonExecutableAuth: 0,
				unattachedFileParts: 0, // an environment export carries no requests
			},
		};
	}
}
