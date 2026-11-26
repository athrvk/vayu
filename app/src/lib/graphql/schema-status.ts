/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One sentence about the schema in hand, derived from the cache entry alone. Pure and Monaco-free,
 * beside the store whose state it reads. Its one caller is the badge in the Query header, in the
 * same place whether the explorer is open or shut (#1224); the sentence stays here because a second
 * copy of these words in a second surface is how two came to say the same thing differently (#455).
 */

import type { SchemaEntry, SchemaFailure } from "./schema-cache";
import { formatInstant } from "@/lib/time-value";

/**
 * What the badge says about a failure, per kind: the store keeps the classified failure and the
 * engine's own words, and this is the sentence that names the fix, so an expired token and an
 * endpoint with introspection switched off (opposite actions) never read alike (#383). Exhaustive
 * by type: a new failure kind in `introspect.ts` is a type error here rather than a silent fall
 * back to the generic sentence.
 */
export const FAILURE_HINT: Record<SchemaFailure["kind"], string> = {
	auth: "Credentials were rejected. Check the request's auth, then refresh.",
	unsupported: "This endpoint does not allow introspection, so only syntax is checked.",
	http: "The endpoint answered with an error status.",
	network: "Couldn't reach the endpoint.",
	parse: "The answer was not an introspection result.",
	"too-large": "The schema is too large to load.",
	unknown: "Couldn't complete introspection.",
};

export function schemaStatusTitle(entry: SchemaEntry | null, awaitingLoad = false): string {
	const age = entry?.fetchedAt
		? `Schema loaded ${formatInstant(entry.fetchedAt, "relative")}.`
		: null;
	const status = entry?.status ?? "idle";

	if (status === "idle" && awaitingLoad) {
		return "Vayu has not contacted this endpoint yet, so its schema has not been loaded. Load it to validate and complete the query.";
	}
	if (status === "idle") return "The schema has not been loaded yet.";
	if (status === "loading") return age ?? "Loading the schema.";
	if (status === "ready") return age ?? "Schema loaded.";

	const failure = entry?.error;
	const hint = FAILURE_HINT[failure?.kind ?? "unknown"];
	const detail = failure?.message ? `${hint} ${failure.message}` : hint;
	/*
	 * A refresh that failed over a schema that loaded earlier is not "no schema": the editors still
	 * complete against the last good one, so this says how old it is and what went wrong.
	 */
	if (entry?.schema) return age ? `${detail} ${age}` : detail;
	return `${detail} Syntax checking only.`;
}
