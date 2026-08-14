/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import yaml from "js-yaml";
import type { CollectionDraft, ImportOptions, ImportParser, ImportResult } from "./types";
import { UnrecognisedFormatError } from "./types";
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

function parseRaw(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		// Throws on malformed YAML - let it propagate as a parse error.
		return yaml.load(raw);
	}
}

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
 * Parse a raw import string. Parses once (JSON then YAML fallback), then runs detectors in order.
 * @throws UnrecognisedFormatError if no parser claims the input.
 */
export function parseImport(raw: string, opts: ImportOptions, fileName?: string): ImportResult {
	const parsed = parseRaw(raw);
	for (const parser of PARSERS) {
		if (parser.detect(parsed, raw)) {
			const result = parser.parse(parsed, raw, opts);
			if (fileName) result.meta.fileName = fileName;
			joinParamsIntoUrls(result);
			return result;
		}
	}
	throw new UnrecognisedFormatError();
}
