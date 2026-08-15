/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import yaml from "js-yaml";

/**
 * Parse an import's raw text once: JSON, then YAML.
 *
 * Its own module because two callers need the *same* answer - the factory, which
 * hands the parsed value to the detectors, and the ref bundler (issue #649),
 * which has to walk the same document before parse to resolve external refs. A
 * second copy would be a second opinion about what the bytes are.
 *
 * @throws on malformed YAML - the caller reports it as a parse error.
 */
export function parseRaw(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		// Throws on malformed YAML - let it propagate as a parse error.
		return yaml.load(raw);
	}
}
