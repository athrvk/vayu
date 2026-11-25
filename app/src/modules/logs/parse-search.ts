/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The search box's grammar as the main process reads it (#3635). `electron/log-reader.ts`'s
 * `parseSearchInput` is the reader's own copy and `src/` may not import from `electron/`, so this
 * is a second one, held equal by `electron/log-search.conformance.test.ts`, which runs both over
 * the same inputs: a rule changed on one side alone reds that test.
 *
 * Filters are evaluated in main, so what leaves the renderer is this parse (free text plus
 * `field:value` terms), never the raw box.
 */

import type { LogFieldTerm } from "@/types/electron";

/** A field name, as `docs/engine/log-record.schema.json`'s `propertyNames` allows one. */
const FIELD_NAME = /^[a-z][a-zA-Z0-9_]*$/;

/** A quoted run (with any prefix glued to it, `cat:"oauth"`), or a bare token. */
const SEARCH_TOKEN = /([^\s"]*)"([^"]*)"|(\S+)/g;

/**
 * A search box's text as free text plus `field:value` terms. `field:"v w"` is an
 * exact term, `field:v` a substring one; everything else, quoted phrases
 * included, joins into the free text. A value starting `//` is a URL
 * (`http://host`), not a term.
 */
export function parseSearchInput(input: string): { text: string; terms: LogFieldTerm[] } {
	const words: string[] = [];
	const terms: LogFieldTerm[] = [];
	for (const [token, prefix, quoted, bare] of input.matchAll(SEARCH_TOKEN)) {
		if (bare !== undefined) {
			const colon = bare.indexOf(":");
			const field = bare.slice(0, colon);
			const value = bare.slice(colon + 1);
			if (colon > 0 && FIELD_NAME.test(field) && value !== "" && !value.startsWith("//")) {
				terms.push({ field, value, exact: false });
			} else {
				words.push(bare);
			}
			continue;
		}
		const field = prefix.endsWith(":") ? prefix.slice(0, -1) : "";
		if (FIELD_NAME.test(field)) {
			terms.push({ field, value: quoted, exact: true });
		} else {
			words.push(prefix === "" ? quoted : token);
		}
	}
	return { text: words.join(" "), terms };
}
