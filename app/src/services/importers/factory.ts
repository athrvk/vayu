/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Parsing an import document: one call to the engine (#877).
 *
 * **Parsing is the engine's, not this file's.** A renderer-side parser stack would be the *second*
 * reader of a document, and two readers of one document disagree exactly where it matters (#853,
 * #860, #865, #854). Because the parse is a route, an agent over MCP can import a document as well
 * as bind, diff, sync and export a spec.
 *
 * What stays renderer-side is everything that is not the parse: which file the user picked
 * (`batch.ts`), what the preview says about it (`ImportModal`), the temp ids an apply references
 * items by (`assign-ids.ts`) and the flattening into the payload (`orchestrator.ts`). Detection is
 * the engine's too, in a fixed order, so the same bytes are always claimed by the same format.
 */

import { apiService } from "@/services/api";
import type { ImportOptions, ImportResult, ImportSource } from "./types";
import { UnrecognisedFormatError } from "./types";
import { ApiError } from "@/services/http-client";

/**
 * Where the raw text came from. Declared beside `ImportParser` in `./types`,
 * and re-exported here because this is where every caller already reaches for
 * it.
 */
export type { ImportSource };

/** The engine's sentence for a document no format claims. */
const UNRECOGNISED = "Unrecognised format";

/**
 * Parse a raw import string.
 *
 * @throws UnrecognisedFormatError when no format claims the input, so callers can tell that apart
 *        from a document that claimed one and is broken: the dialog says different things about the
 *        two, and one error for both would tell a user their Postman export is unreadable when Vayu
 *        simply never looked at it as one.
 */
export async function parseImport(
	raw: string,
	opts: ImportOptions,
	source: ImportSource = {}
): Promise<ImportResult> {
	try {
		return await apiService.parseImport({
			content: raw,
			importEnvironments: opts.importEnvironments,
			importScripts: opts.importScripts,
			...(source.fileName ? { fileName: source.fileName } : {}),
			...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
			...(source.unresolvedRefs ? { unresolvedRefs: source.unresolvedRefs } : {}),
		});
	} catch (e) {
		if (e instanceof ApiError && e.message === UNRECOGNISED)
			throw new UnrecognisedFormatError();
		throw e;
	}
}
