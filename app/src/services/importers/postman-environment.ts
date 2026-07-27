/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { EnvironmentDraft, ImportOptions, ImportParser, ImportResult } from "./types";
import { asString, toVarRecord } from "./shared";

/**
 * Postman exports an environment as its own file, separate from the collection
 * export - which is why `postman.ts` correctly returns `environments: []`. This
 * parser reads that separate file.
 *
 * The result has no collections at all, the only parser that produces that.
 * `ImportOrchestrator.run` already handles it (its collection loop simply does
 * not execute), and `ImportModal` blocks the import when nothing would be
 * created rather than closing on a no-op.
 *
 * Only `_postman_variable_scope: "environment"` is claimed. Postman uses the
 * same file shape for `"globals"`; whether an import may write Vayu's globals
 * scope is a separate decision (issue #153), so a globals file stays
 * unrecognised rather than being silently routed somewhere.
 */
export class PostmanEnvironmentParser implements ImportParser {
	readonly formatName = "Postman Environment";
	readonly formatKey = "postman-environment";

	detect(parsed: unknown, _raw: string): boolean {
		const p = parsed as { _postman_variable_scope?: unknown; values?: unknown } | null;
		return p?._postman_variable_scope === "environment" && Array.isArray(p?.values);
	}

	parse(parsed: unknown, _raw: string, opts: ImportOptions): ImportResult {
		const p = parsed as { name?: unknown; values?: unknown };
		// Gated at parse time, matching InsomniaV4Parser: with the option off the
		// draft carries no environments and `environmentCount` reports 0, so the
		// preview shows what will actually be created.
		const environments: EnvironmentDraft[] = opts.importEnvironments
			? [
					{
						name: asString(p.name) || "Imported Environment",
						description: "",
						variables: toVarRecord(
							(p.values ?? []) as Parameters<typeof toVarRecord>[0]
						),
					},
				]
			: [];

		return {
			collections: [],
			environments,
			meta: {
				format: this.formatName,
				requestCount: 0,
				folderCount: 0,
				environmentCount: environments.length,
				skipped: [],
				nonExecutableAuth: 0,
			},
		};
	}
}
