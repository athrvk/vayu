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
 * {@link buildChangeset} returns and sends what {@link applyRunToRequest}
 * builds, so the rule about what may be written is testable without rendering
 * anything.
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
 * Neither is silent: {@link buildChangeset} emits both as `kept` rows, in the
 * same list as every change, with the reason inline. That is what makes "an
 * older run saves fewer fields" visible rather than surprising.
 */

import type { KeyValueEntry, Request, RequestBody, UpdateRequestRequest } from "@/types";
import type { KeyValueItem, RequestState } from "@/modules/request-builder/types";
import { toKeyValueEntries } from "@/modules/request-builder/utils/key-value";
import { SYSTEM_HEADER_KEYS } from "@/modules/request-builder/utils/system-headers";
import type { DesignRunSeed } from "./design-run-seed";

/** How one key/value entry differs between the request and the run. */
export type EntryChangeKind = "added" | "removed" | "changed";

/** One key's change within a key/value field (Headers, Params). */
export interface EntryChange {
	key: string;
	kind: EntryChangeKind;
	/** Present for `removed` and `changed`. */
	from?: string;
	/** Present for `added` and `changed`. */
	to?: string;
}

/** What happens to a field when the run is saved. */
export type ChangeState = "changed" | "removed" | "added" | "kept";

/** One run of characters in a value diff: shared, removed, or added. */
export interface DiffSeg {
	text: string;
	kind: "same" | "del" | "add";
}

/** A per-key change within a key/value field, ready to render. */
export interface ChangesetEntry {
	key: string;
	kind: EntryChangeKind;
	/** Present for `changed` - the value diffed segment by segment. */
	segments?: DiffSeg[];
	/** Present for `added` / `removed` - the whole value. */
	value?: string;
}

/**
 * One row of the confirmation, whatever its field. The dialog shows every field
 * the same way - there is no separate "unchanged" section - so a scalar change,
 * a key/value change, and a kept field are all `ChangesetItem`s, told apart by
 * `state` and by which of the optional carriers is set.
 */
export interface ChangesetItem {
	field: string;
	state: ChangeState;
	/** Right-aligned label: "changed", "2 removed", "kept", "kept · differs". */
	detail: string;
	/** A scalar changed value (URL, body, a script), diffed. */
	segments?: DiffSeg[];
	/** A key/value field (Headers, Params). */
	entries?: ChangesetEntry[];
	/** A kept field's plain value (auth mode when it matches). */
	value?: string;
	/** A kept field whose value drifted (auth mode differs), shown neutral. */
	driftFrom?: string;
	driftTo?: string;
	/** Why a kept field is not written. */
	note?: string;
	/** A long value (a script) that opens on demand rather than always. */
	collapsible?: boolean;
}

/**
 * A minimal value diff: the shared prefix and suffix stay, and the middle that
 * differs becomes one removed run and one added run. It covers the common
 * single-edit case - a changed URL tail, a header value, a one-spot script edit -
 * with no dependency. A multi-part edit collapses to a single del+add span,
 * which still reads as "this middle changed"; swap in a real word-differ (jsdiff)
 * if finer hunks are ever wanted.
 */
export function diffSegments(from: string, to: string): DiffSeg[] {
	if (from === to) return [{ text: from, kind: "same" }];
	const max = Math.min(from.length, to.length);
	let start = 0;
	while (start < max && from[start] === to[start]) start++;
	let endF = from.length;
	let endT = to.length;
	while (endF > start && endT > start && from[endF - 1] === to[endT - 1]) {
		endF--;
		endT--;
	}
	const segs: DiffSeg[] = [];
	if (start > 0) segs.push({ text: from.slice(0, start), kind: "same" });
	if (endF > start) segs.push({ text: from.slice(start, endF), kind: "del" });
	if (endT > start) segs.push({ text: to.slice(start, endT), kind: "add" });
	const suffix = from.slice(endF);
	if (suffix) segs.push({ text: suffix, kind: "same" });
	return segs;
}

/**
 * The app's own managed headers - `X-Vayu-Version`, `X-Request-ID`, `User-Agent`.
 * They are injected fresh on every send and re-added by the builder on load, so
 * they never belong in a saved request: a stored run carries whatever version it
 * sent, and writing that back would pin an old version onto the request. Dropped
 * from both the diff and the write.
 */
function userEntries(entries: KeyValueEntry[]): KeyValueEntry[] {
	return entries.filter((e) => !SYSTEM_HEADER_KEYS.has(e.key.trim().toLowerCase()));
}

/** Enabled, non-empty keys as a map; last value wins on a duplicate key. */
function entryMap(entries: KeyValueEntry[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const e of entries) {
		if (e.enabled === false || !e.key.trim()) continue;
		map.set(e.key, e.value);
	}
	return map;
}

/**
 * A per-key diff of two key/value lists. Added and changed keys come first in
 * the new list's order, removed keys after - so the result reads as "here is
 * what the request will have", with the losses noted at the end.
 */
function diffEntries(from: KeyValueEntry[], to: KeyValueEntry[]): EntryChange[] {
	const before = entryMap(from);
	const after = entryMap(to);
	const changes: EntryChange[] = [];

	for (const [key, toValue] of after) {
		if (!before.has(key)) {
			changes.push({ key, kind: "added", to: toValue });
		} else if (before.get(key) !== toValue) {
			changes.push({ key, kind: "changed", from: before.get(key), to: toValue });
		}
	}
	for (const [key, fromValue] of before) {
		if (!after.has(key)) changes.push({ key, kind: "removed", from: fromValue });
	}
	return changes;
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

/** Right-aligned label for a key/value field: "2 removed", "1 changed", "3 changes". */
function entriesLabel(entries: EntryChange[]): string {
	const kinds = new Set(entries.map((e) => e.kind));
	const n = entries.length;
	if (kinds.size === 1) {
		const word = [...kinds][0]; // added | removed | changed
		return `${n} ${word}`;
	}
	return `${n} ${n === 1 ? "change" : "changes"}`;
}

/** Field-level state for a key/value field: the single kind, or "changed" if mixed. */
function entriesState(entries: EntryChange[]): ChangeState {
	const kinds = new Set(entries.map((e) => e.kind));
	return kinds.size === 1 ? ([...kinds][0] as ChangeState) : "changed";
}

/** Number of lines that differ, for a collapsed script row's summary. */
function changedLineLabel(from: string, to: string): string {
	const a = from.split("\n");
	const b = to.split("\n");
	const n = Math.max(a.length, b.length);
	let changed = 0;
	for (let i = 0; i < n; i++) if ((a[i] ?? "") !== (b[i] ?? "")) changed++;
	return `${changed} ${changed === 1 ? "line" : "lines"}`;
}

/** The Auth row - always kept, since a run stores the mode only. */
function authItem(seed: DesignRunSeed, live: Request): ChangesetItem {
	const liveMode = live.auth?.mode || "none";
	const runMode = seed.recordedAuthMode || "none";
	if (liveMode === runMode) {
		return {
			field: "Auth",
			state: "kept",
			detail: "kept",
			value: runMode,
			note: "A stored run keeps only the mode, never the credential, so yours is left alone.",
		};
	}
	return {
		field: "Auth",
		state: "kept",
		detail: "kept · differs",
		driftFrom: liveMode,
		driftTo: runMode,
		note: `This run used ${runMode}; it is not written, because a stored run keeps only the mode.`,
	};
}

/**
 * The whole confirmation as one list. Every field a Save touches is a row, in
 * the order the request stores them, plus Auth (always kept) and - for a run
 * stored before per-part scripts - Scripts (kept). Fields that already match the
 * run are left out, so an unchanged save shows only the two kept rows.
 *
 * System headers are stripped from the patch and from the comparison, so the
 * app's own `X-Vayu-Version` / `X-Request-ID` never appear as changes.
 */
export function buildChangeset(seed: DesignRunSeed, live: Request): ChangesetItem[] {
	const patch = applyRunToRequest(seed, live);
	const items: ChangesetItem[] = [];

	const scalar = (field: string, from: string, to: string, collapsible = false) => {
		if (from === to) return;
		items.push({
			field,
			state: "changed",
			detail: collapsible ? changedLineLabel(from, to) : "changed",
			segments: diffSegments(from, to),
			collapsible,
		});
	};

	const keyValues = (field: string, from: KeyValueEntry[], to: KeyValueEntry[]) => {
		const raw = diffEntries(userEntries(from), userEntries(to));
		if (raw.length === 0) return;
		const entries: ChangesetEntry[] = raw.map((e) =>
			e.kind === "changed"
				? { key: e.key, kind: e.kind, segments: diffSegments(e.from ?? "", e.to ?? "") }
				: { key: e.key, kind: e.kind, value: e.kind === "added" ? e.to : e.from }
		);
		items.push({ field, state: entriesState(raw), detail: entriesLabel(raw), entries });
	};

	scalar("Method", live.method, patch.method ?? live.method);
	scalar("URL", live.url, patch.url ?? live.url);
	keyValues("Params", live.params ?? [], patch.params ?? []);
	keyValues("Headers", live.headers ?? [], patch.headers ?? []);
	scalar("Body", describeBody(live.body), describeBody(patch.body ?? live.body));

	if (isLegacyRun(seed)) {
		items.push({
			field: "Scripts",
			state: "kept",
			detail: "kept",
			note: "This run predates per-part scripts, so its collection and request scripts are one string that cannot be split apart.",
		});
	} else {
		// `undefined` means the patch does not write the field, so it is not a change.
		if (patch.preRequestScript !== undefined) {
			scalar("Pre-request script", live.preRequestScript || "", patch.preRequestScript, true);
		}
		if (patch.postRequestScript !== undefined) {
			scalar("Test script", live.postRequestScript || "", patch.postRequestScript, true);
		}
	}

	scalar(
		"Follow redirects",
		String(live.followRedirects),
		String(patch.followRedirects ?? live.followRedirects)
	);
	scalar(
		"Max redirects",
		String(live.maxRedirects),
		String(patch.maxRedirects ?? live.maxRedirects)
	);

	items.push(authItem(seed, live));

	return items;
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
		// System headers are dropped, not persisted: the builder re-injects them
		// with current values on load, so writing a run's stale X-Vayu-Version /
		// X-Request-ID would pin an old version onto the request.
		headers: userEntries(items(request.headers)),
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
