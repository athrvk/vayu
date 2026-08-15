/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One parsed request draft as the fields an engine write carries.
 *
 * Two callers build a request row out of a draft now: the import orchestrator,
 * which sends the whole tree to `POST /import/apply`, and the OpenAPI sync,
 * which sends the operations a re-fetched document added to `POST /specs/sync`
 * (issue #655). A second copy of this mapping is exactly the shape of bug this
 * repo keeps finding - a field added for one path and silently missing on the
 * other - so the mapping lives here and the two callers add only what is
 * genuinely theirs (a temp id, an owner, a position).
 */

import type { ImportApplyRequestItem } from "@/types";
import type { RequestDraft } from "./types";

/** Everything about a request that comes from the draft, and nothing about where it lands. */
export type DraftRequestFields = Omit<
	ImportApplyRequestItem,
	"tempId" | "collectionTempId" | "order"
>;

export function requestFieldsFromDraft(r: RequestDraft): DraftRequestFields {
	return {
		name: r.name,
		description: r.description,
		method: r.method,
		url: r.url,
		params: r.params,
		headers: r.headers,
		body: r.body,
		bodyType: r.body.mode, // engine never derives this
		auth: r.auth,
		preRequestScript: r.preRequestScript,
		postRequestScript: r.postRequestScript,
		// Spread rather than assigned so the payload object holds the key only
		// when the source stated it. `JSON.stringify` would drop an `undefined`
		// property anyway, but the payload is also compared structurally in
		// tests, and "absent" is the state the engine's field appliers read.
		...(r.followRedirects !== undefined ? { followRedirects: r.followRedirects } : {}),
		...(r.maxRedirects !== undefined ? { maxRedirects: r.maxRedirects } : {}),
		// Saved example responses ride nested on their request rather than as a
		// section of their own: nothing references them, so they need no temp id,
		// and the engine writes them in the same transaction. Spread for the same
		// reason as the two fields above - a parser that has no examples must not
		// send `examples: []`, which reads as "this request documents no
		// responses" rather than "this format has none".
		...(r.examples !== undefined ? { examples: r.examples } : {}),
		// Spread for the same reason as the fields above: a format with no concept
		// of a spec operation must not send `specOperation: null`, which the engine
		// reads as "clear it" rather than "never had one".
		...(r.specOperation !== undefined ? { specOperation: r.specOperation } : {}),
	};
}
