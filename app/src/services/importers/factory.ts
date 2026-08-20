/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Parsing an import document - one call to the engine (issue #877).
 *
 * **This file used to be the dispatcher of a parser stack.** Six detectors ran
 * in order over a document parsed here with `js-yaml`, and whichever claimed it
 * built the whole tree: `openapi-v3.ts`, `openapi-v2.ts` and their shared half,
 * `postman.ts`, `postman-environment.ts`, `insomnia-v4.ts`, the schema sampler,
 * the OAuth mapper. All of it is gone, engine-side, and the reason is not tidiness:
 * it was the *second* reader of a document. #853 moved what a stored OpenAPI
 * document declares, #860 its response schemas, #865 the requests an import
 * would build and #854 what a re-fetch would change - and every one of those
 * had to be pinned to this stack by a cross-language conformance fixture,
 * because two readers of one document disagree exactly where it matters. There
 * is one reader now, so there is nothing left to pin.
 *
 * It also made a hole an agent could see: `POST /import/apply` took a
 * pre-parsed tree, so over MCP a spec could be bound, diffed, synced and
 * exported but a document could not be *imported* at all. It can now, because
 * the parse is a route.
 *
 * What stays renderer-side is everything that is not the parse: which file the
 * user picked (`batch.ts`), what the preview says about it (`ImportModal`), the
 * temp ids an apply references items by (`assign-ids.ts`) and the flattening
 * into the payload (`orchestrator.ts`). Detection is the engine's, in the order
 * this file used to run it, so the same bytes are claimed by the same format.
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
 * @throws UnrecognisedFormatError when no format claims the input, so callers
 * keep telling that apart from a document that claimed one and is broken - the
 * dialog says different things about the two, and folding them into one error
 * would tell a user their Postman export is unreadable when Vayu simply never
 * looked at it as one.
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
