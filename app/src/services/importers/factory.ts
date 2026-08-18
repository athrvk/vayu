/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type {
	CollectionDraft,
	ImportOptions,
	ImportParser,
	ImportResult,
	ImportSource,
} from "./types";
import { UnrecognisedFormatError } from "./types";
import { parseRaw } from "./parse-raw";
import { appendParamsToUrl } from "@/modules/request-builder/utils/url";
import { PostmanV21Parser, PostmanV20Parser } from "./postman";
import { PostmanEnvironmentParser } from "./postman-environment";
import { InsomniaV4Parser } from "./insomnia-v4";
import { OpenApiV3Parser } from "./openapi-v3";
import { OpenApiV2Parser } from "./openapi-v2";

// Detection order: most specific first (see spec "Detection Order").
const PARSERS: ImportParser[] = [
	new PostmanV21Parser(),
	new PostmanV20Parser(),
	// An environment export carries neither `info` nor `item[]`, so v2.0's
	// permissive fallback branch cannot claim it and this position is not load-bearing.
	new PostmanEnvironmentParser(),
	new InsomniaV4Parser(),
	new OpenApiV3Parser(),
	new OpenApiV2Parser(),
];

/**
 * Restore the app's url/params invariant on every request a parser produced.
 *
 * A request built in the app carries its enabled query **inside `url`**: the
 * Params table rewrites the URL on every edit, and every execution path - design
 * Send, scenario run, load run - sends `url` verbatim while `params[]` stays
 * editor state no engine path ever reads. The parsers write the other shape:
 * Postman splits the query out of the URL into `params[]`, OpenAPI synthesises
 * params for a URL that never had one, Insomnia carries a `parameters[]` beside
 * the URL. An imported request therefore went on the wire with its query
 * missing, silently, until the user happened to edit the table once - which
 * repaired the URL and hid the bug (issue #590).
 *
 * One pass here rather than a call in each parser: it is one rule for every
 * format including the next one, and it leaves each parser's own mapping honest
 * - `params[]` still mirrors exactly what the source declared, disabled rows
 * included, and only the enabled rows reach `url`.
 */
function joinParamsIntoUrls(result: ImportResult): void {
	const walk = (c: CollectionDraft): void => {
		for (const r of c.requests) r.url = appendParamsToUrl(r.url, r.params);
		for (const child of c.children) walk(child);
	};
	for (const c of result.collections) walk(c);
}

/**
 * Where the raw text came from. Declared beside `ImportParser` in `./types`,
 * since `parse` now takes it, and re-exported here because this is where every
 * caller already reaches for it.
 */
export type { ImportSource };

/**
 * Parse a raw import string. Parses once (JSON then YAML fallback), then runs detectors in order.
 * @throws UnrecognisedFormatError if no parser claims the input.
 */
export function parseImport(
	raw: string,
	opts: ImportOptions,
	source: ImportSource = {}
): ImportResult {
	const parsed = parseRaw(raw);
	for (const parser of PARSERS) {
		if (parser.detect(parsed, raw)) {
			// `source` reaches `parse` because a relative `servers[0].url` is
			// relative to where the document was fetched from, and only the parser
			// knows it has one (issue #719).
			const result = parser.parse(parsed, raw, opts, source);
			if (source.fileName) result.meta.fileName = source.fileName;
			// Stamped here rather than read inside `parse`, for the same reason
			// `fileName` is: what a spec document records about its own origin is
			// the caller's knowledge, and only a format that produced one has
			// anywhere to put it. A non-OpenAPI import carries no `spec`, so this is
			// a no-op.
			if (source.sourceUrl) {
				for (const collection of result.collections) {
					if (collection.spec) collection.spec.sourceUrl = source.sourceUrl;
				}
			}
			if (source.unresolvedRefs && source.unresolvedRefs > 0) {
				result.meta.skipped.push({
					kind: "external_ref",
					count: source.unresolvedRefs,
				});
			}
			joinParamsIntoUrls(result);
			return result;
		}
	}
	throw new UnrecognisedFormatError();
}
