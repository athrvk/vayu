/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Copy a stored run's values back onto the request it came from.
 *
 * Pure on purpose - no hooks, no queries. The dialog shows what
 * {@link diffRunAgainstRequest} returns and sends what
 * {@link applyRunToRequest} builds, so the rule about what may be written is
 * testable without rendering anything.
 *
 * ## What is deliberately not written
 *
 * **Auth, always.** `sanitize_config_snapshot` (engine, `utils/json.cpp`)
 * strips a stored run's auth down to `{"mode": ...}` before saving, so the run
 * knows the *mode* and nothing else. Writing that back would replace the live
 * request's real credentials with a bare mode - and credentials exist nowhere
 * else, so nothing could recover them.
 *
 * **Scripts, for a run stored before script parts existed.** Those runs hold
 * one string glued from the collection chain's scripts plus the request's own,
 * with nothing marking the boundaries. The request's own part cannot be
 * recovered from it, and writing the whole string would bury the collection's
 * script inside the request permanently - the next send would glue it on again
 * and run it twice.
 *
 * Neither exclusion is silent: {@link excludedFromSave} names both, and the
 * dialog lists them as unchanged. That is what makes "an older run saves fewer
 * fields" visible rather than surprising.
 */

import type { KeyValueEntry, Request, RequestBody, UpdateRequestRequest } from "@/types";
import type { KeyValueItem, RequestState } from "@/modules/request-builder/types";
import { toKeyValueEntries } from "@/modules/request-builder/utils/key-value";
import type { DesignRunSeed } from "./design-run-seed";

/** One row of the confirmation's "what will change" list. */
export interface RunSaveChange {
	field: string;
	from: string;
	to: string;
}

/** One row of the confirmation's "left alone" list. */
export interface RunSaveExclusion {
	field: string;
	reason: string;
}

/**
 * A run stored before the engine took over joining scripts. Its parts cannot be
 * separated, so Save leaves scripts alone.
 */
export function isLegacyRun(seed: DesignRunSeed): boolean {
	return seed.legacyPreScript !== undefined || seed.legacyPostScript !== undefined;
}

function items(value: KeyValueItem[] | undefined): KeyValueEntry[] {
	return toKeyValueEntries(value ?? []);
}

/** Build the stored body shape from the seed's flat editor fields. */
function bodyFromSeed(request: Partial<RequestState>): RequestBody {
	const mode = request.bodyMode ?? "none";
	if (mode === "form-data") {
		return { mode: "form-data", fields: items(request.formData) };
	}
	if (mode === "x-www-form-urlencoded") {
		return { mode: "x-www-form-urlencoded", fields: items(request.urlEncoded) };
	}
	if (mode !== "none" && request.body) {
		return { mode: mode as "json" | "text" | "graphql", content: request.body };
	}
	return { mode: "none" };
}

/** A stable, human-readable rendering of a key/value list, for the diff only. */
function describeEntries(entries: KeyValueEntry[]): string {
	const enabled = entries.filter((e) => e.enabled !== false && e.key.trim());
	if (enabled.length === 0) return "none";
	return enabled.map((e) => `${e.key}: ${e.value}`).join(", ");
}

function describeBody(body: RequestBody | undefined): string {
	// The engine omits a body node entirely for some stored rows, and this runs
	// against whatever the request query returned - so do not assume the field.
	if (!body || body.mode === "none") return "none";
	if ("fields" in body) return `${body.mode} (${describeEntries(body.fields)})`;
	return `${body.mode} (${body.content || ""})`;
}

/**
 * Everything Save would write, as `field -> {from, to}` pairs, **excluding
 * fields whose value already matches**. A run opened and saved unchanged
 * produces an empty list, which is what lets the dialog say so instead of
 * listing seven identical rows.
 */
export function diffRunAgainstRequest(seed: DesignRunSeed, live: Request): RunSaveChange[] {
	const patch = applyRunToRequest(seed, live);
	const changes: RunSaveChange[] = [];

	const add = (field: string, from: string, to: string) => {
		if (from !== to) changes.push({ field, from, to });
	};

	add("Method", live.method, patch.method ?? live.method);
	add("URL", live.url, patch.url ?? live.url);
	add("Params", describeEntries(live.params ?? []), describeEntries(patch.params ?? []));
	add("Headers", describeEntries(live.headers ?? []), describeEntries(patch.headers ?? []));
	add("Body", describeBody(live.body), describeBody(patch.body ?? live.body));

	// Absent for a legacy run, and absent means "not written" - so it must not
	// be reported as a change to "".
	if (patch.preRequestScript !== undefined) {
		add(
			"Pre-request script",
			live.preRequestScript || "none",
			patch.preRequestScript || "none"
		);
	}
	if (patch.postRequestScript !== undefined) {
		add("Test script", live.postRequestScript || "none", patch.postRequestScript || "none");
	}

	add(
		"Follow redirects",
		String(live.followRedirects),
		String(patch.followRedirects ?? live.followRedirects)
	);
	add(
		"Max redirects",
		String(live.maxRedirects),
		String(patch.maxRedirects ?? live.maxRedirects)
	);

	return changes;
}

/**
 * The fields Save will *not* touch, with the reason. Shown alongside the diff
 * so the exclusions read as a decision rather than an omission.
 */
export function excludedFromSave(seed: DesignRunSeed): RunSaveExclusion[] {
	const excluded: RunSaveExclusion[] = [
		{
			field: "Auth",
			reason: "A stored run keeps only the auth mode - never the credential. Writing it back would discard the request's own.",
		},
	];

	if (isLegacyRun(seed)) {
		excluded.push({
			field: "Scripts",
			reason: "This run predates per-part scripts, so its collection and request scripts are one string that cannot be split apart again.",
		});
	}

	return excluded;
}

/**
 * The update payload for the saved request. Note there is no `auth` key at all
 * - not `auth: undefined`, which some callers would still serialise.
 */
export function applyRunToRequest(seed: DesignRunSeed, live: Request): UpdateRequestRequest {
	const request = seed.request;
	const body = bodyFromSeed(request);

	const patch: UpdateRequestRequest = {
		id: live.id,
		method: request.method ?? live.method,
		url: request.url ?? live.url,
		params: items(request.params),
		headers: items(request.headers),
		body,
		bodyType: body.mode,
		followRedirects: request.followRedirects ?? live.followRedirects,
		maxRedirects: request.maxRedirects ?? live.maxRedirects,
	};

	if (!isLegacyRun(seed)) {
		patch.preRequestScript = request.preRequestScript ?? "";
		patch.postRequestScript = request.testScript ?? "";
	}

	return patch;
}
