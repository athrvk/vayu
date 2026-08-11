/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One sentence about the schema in hand, derived from the cache entry alone.
 *
 * Pure and Monaco-free, beside the store whose state it reads, because two
 * surfaces render it - the explorer's header badge and the Query pane's chip -
 * and a second copy of these words in one of them is how the two came to say
 * the same thing differently in the first place (#455).
 */

import type { SchemaEntry, SchemaFailure } from "./schema-cache";
import { formatRelativeTime } from "@/utils/helpers";

/**
 * What the badge says about a failure, per kind.
 *
 * The store keeps the classified failure and the engine's own words; this is
 * the sentence that names the fix. One static "introspection failed" used to
 * cover all of them, so an expired token and an endpoint with introspection
 * switched off - opposite actions - read identically (#383).
 *
 * Exhaustive by type: a new failure kind in `introspect.ts` is a type error
 * here rather than a silent fall back to the generic sentence.
 */
export const FAILURE_HINT: Record<SchemaFailure["kind"], string> = {
	auth: "Credentials were rejected. Check the request's auth, then refresh.",
	unsupported: "This endpoint does not allow introspection, so only syntax is checked.",
	http: "The endpoint answered with an error status.",
	network: "The endpoint could not be reached.",
	parse: "The answer was not an introspection result.",
	"too-large": "The schema is too large to load.",
	unknown: "Introspection failed.",
};

export function schemaStatusTitle(entry: SchemaEntry | null): string {
	const age = entry?.fetchedAt ? `Schema loaded ${formatRelativeTime(entry.fetchedAt)}.` : null;
	const status = entry?.status ?? "idle";

	if (status === "idle") return "The schema has not been loaded yet.";
	if (status === "loading") return age ?? "Loading the schema.";
	if (status === "ready") return age ?? "Schema loaded.";

	const failure = entry?.error;
	const hint = FAILURE_HINT[failure?.kind ?? "unknown"];
	const detail = failure?.message ? `${hint} ${failure.message}` : hint;
	/*
	 * A refresh that failed over a schema that loaded earlier is not "no
	 * schema": the editors still complete against the last good one, so this
	 * says how old it is and what went wrong rather than claiming there is
	 * nothing.
	 */
	if (entry?.schema) return age ? `${detail} ${age}` : detail;
	return `${detail} Syntax checking only.`;
}
