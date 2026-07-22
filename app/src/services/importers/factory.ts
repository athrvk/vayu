/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import yaml from "js-yaml";
import type { ImportOptions, ImportParser, ImportResult } from "./types";
import { UnrecognisedFormatError } from "./types";
import { PostmanV21Parser, PostmanV20Parser } from "./postman";
import { InsomniaV4Parser } from "./insomnia-v4";
import { OpenApiV3Parser } from "./openapi-v3";
import { OpenApiV2Parser } from "./openapi-v2";

// Detection order: most specific first (see spec "Detection Order").
const PARSERS: ImportParser[] = [
	new PostmanV21Parser(),
	new PostmanV20Parser(),
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
 * Parse a raw import string. Parses once (JSON then YAML fallback), then runs detectors in order.
 * @throws UnrecognisedFormatError if no parser claims the input.
 */
export function parseImport(raw: string, opts: ImportOptions, fileName?: string): ImportResult {
	const parsed = parseRaw(raw);
	for (const parser of PARSERS) {
		if (parser.detect(parsed, raw)) {
			const result = parser.parse(parsed, raw, opts);
			if (fileName) result.meta.fileName = fileName;
			return result;
		}
	}
	throw new UnrecognisedFormatError();
}
