/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Copy a stored run's values back onto the request it came from. Pure (no hooks, no queries): the
 * dialog shows what {@link buildChangeset} returns and sends what {@link applyRunToRequest} builds,
 * so the rule about what may be written is testable without rendering. {@link createFieldsFromRun}
 * is the same rule for a run with no saved request (an agent's, #1817): one definition, two
 * writers.
 *
 * ## What is deliberately not written
 *
 * **Auth, always.** `sanitize_config_snapshot` (engine, `utils/json.cpp`) strips a stored run's
 * auth to `{"mode": ...}`, so the run knows the *mode* only. Writing it back would replace the live
 * request's real credentials with a bare mode, and they exist nowhere else to recover.
 *
 * **Whatever the engine withheld from the snapshot** (#1803). A credential header's value, and a
 * secret variable's value inside the url, params, headers or body, are stored as `<redacted>`,
 * which is not what the request holds, so writing it back would overwrite a good value with the
 * marker. A header keeps the request's own (the seed never carries the withheld row); a url, params
 * or body holding the marker is left off the patch like a truncated body.
 *
 * **Scripts, for a run stored before script parts existed.** Such a run holds one string glued from
 * the collection chain's scripts and the request's own, with no boundaries. The request's own part
 * cannot be recovered, and writing the whole string would bury the collection's script in the
 * request permanently: the next send would glue it on again and run it twice.
 *
 * **Body, for a run whose stored request body was truncated.** The engine caps a stored trace body,
 * and the config snapshot's own body, at `maxTraceBodyBytes`, so such a run holds a slice of what
 * was sent, and writing it back would corrupt the saved body; with `seed.requestBodyTruncated` set
 * the body is left off the patch. So is a `binary` body whose snapshot recorded no path: writing it
 * would point the request at no file.
 *
 * None is silent: {@link buildChangeset} emits each as a `kept` row, in the list with every change
 * and its reason inline, so "an older run saves fewer fields" is visible rather than surprising.
 */

import type {
	CreateRequestRequest,
	ElementDef,
	FormFieldEntry,
	KeyValueEntry,
	McpTool,
	Request,
	RequestBody,
	UpdateRequestRequest,
} from "@/types";
import type { KeyValueItem } from "@/types";
import type { RequestState } from "@/modules/request-builder/types";
import { toKeyValueEntries } from "@/components/shared/KeyValueEditor/key-value";
import { isLegacyManagedHeader } from "@/modules/request-builder/utils/system-headers";
import { isPathRow } from "@/modules/request-builder/utils/path-variables";
import { pluralize } from "@/modules/dashboard/utils/format";
import { toFileRef } from "@/modules/request-builder/utils/execute-mapping";
import { withoutFileTrust } from "@/lib/file-trust";
import {
	DEFAULT_DISABLE_COOKIES,
	DEFAULT_DISABLE_URL_ENCODING,
	DEFAULT_FOLLOW_REDIRECTS,
	DEFAULT_HTTP_VERSION,
	DEFAULT_MAX_REDIRECTS,
	DEFAULT_VERIFY_SSL,
} from "@/constants/request";
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
 * One confirmation row, whatever its field. The dialog shows every field the same way (no separate
 * "unchanged" section), so a scalar change, a key/value change and a kept field are all
 * `ChangesetItem`s, told apart by `state` and by which optional carrier is set.
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
 * A minimal value diff: the shared prefix and suffix stay, and the differing middle becomes one
 * removed and one added run. It covers the common single edit (a URL tail, a header value, a
 * one-spot script edit) with no dependency; a multi-part edit collapses to one del+add span, which
 * still reads as "this middle changed". A real word-differ (jsdiff) is the swap if finer hunks are
 * wanted.
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
 * The rows a pre-#1229 Vayu client added to a send, dropped from both the diff and the write. No
 * client writes them now (the engine adds its defaults at send time and nothing is stored), but a
 * run *trace* captured before that still carries them, and this reads traces; writing one back
 * would pin a stale version, or one frozen correlation id, onto the saved request.
 *
 * The rule is `isLegacyManagedHeader`'s, not a key list of its own, so a browser `User-Agent` or a
 * hand-typed `X-Request-ID` the run really sent is saved like any other header. One definition, two
 * readers, so this and the loader cannot disagree.
 */
function userEntries(entries: KeyValueEntry[]): KeyValueEntry[] {
	return entries.filter((e) => !isLegacyManagedHeader(e.key, e.value));
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
 * Params rows keyed for the diff: a path row (#1764) as `:name`, as the URL writes it, so it
 * neither collides with nor reads as a same-named query parameter.
 */
function paramsForDiff(entries: KeyValueEntry[]): KeyValueEntry[] {
	return entries.map((e) => (isPathRow(e) ? { ...e, key: `:${e.key}` } : e));
}

/**
 * A per-key diff of two key/value lists: added and changed keys first, in the new list's order,
 * removed keys after, so it reads as "what the request will have", losses at the end.
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

function items(value: KeyValueItem[] | undefined): FormFieldEntry[] {
	return toKeyValueEntries(value ?? []);
}

/**
 * The stored body shape from the seed's flat editor fields. `savedMcpTool` is the saved request's
 * tool: a run records an `mcp` body's content, not its tool, so a write carrying none would clear
 * it.
 */
function bodyFromSeed(request: Partial<RequestState>, savedMcpTool?: McpTool): RequestBody {
	const mode = request.bodyMode ?? "none";
	if (mode === "form-data") {
		return { mode: "form-data", fields: withoutFileTrust(items(request.formData)) };
	}
	if (mode === "x-www-form-urlencoded") {
		return { mode: "x-www-form-urlencoded", fields: items(request.urlEncoded) };
	}
	if (mode === "binary") {
		return { mode: "binary", file: toFileRef(request.binaryFile) };
	}
	if (mode === "mcp" && request.body) {
		return { mode, content: request.body, ...(savedMcpTool && { mcpTool: savedMcpTool }) };
	}
	if (mode !== "none" && request.body) {
		return {
			mode: mode as "json" | "text" | "graphql" | "jsonrpc" | "xml",
			content: request.body,
		};
	}
	return { mode: "none" };
}

const TRUNCATED_BODY_NOTE =
	"This run's request body was too large to store in full, so only a slice was kept. It is not written back, to avoid overwriting the saved body with an incomplete copy.";
const WITHHELD_URL_NOTE =
	"Vayu's engine withheld a secret from this run's URL, so it is not written back, to avoid overwriting the saved URL with a placeholder.";
const WITHHELD_PARAMS_NOTE =
	"Vayu's engine withheld a secret from this run's URL or params, so the params are not written back, to avoid overwriting the saved params with a placeholder.";
const WITHHELD_BODY_NOTE =
	"Vayu's engine withheld a secret from this run's request body, so it is not written back, to avoid overwriting the saved body with a placeholder.";
const WITHHELD_HEADERS_NOTE =
	"Vayu's engine withholds credential values from a stored run, so the request's own value for each of these headers is kept.";
const PATHLESS_FILE_NOTE =
	"This run did not record which file it sent, so the saved body is left alone rather than pointed at no file.";

/**
 * Why the run's body must not be written back, or null when it may be. A
 * truncated body is a slice; a binary body whose snapshot holds no path would
 * replace the request's file with an empty pick.
 */
function unwritableBodyNote(seed: DesignRunSeed): string | null {
	if (seed.requestBodyTruncated) return TRUNCATED_BODY_NOTE;
	if (seed.withheld.body) return WITHHELD_BODY_NOTE;
	if (seed.request.bodyMode === "binary" && !seed.request.binaryFile?.src) {
		return PATHLESS_FILE_NOTE;
	}
	return null;
}

/** A `kept` row for a field the save leaves alone, with the reason inline. */
function keptItem(field: string, value: string, note: string): ChangesetItem {
	return { field, state: "kept", detail: "kept", value, note };
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
	if (body.mode === "binary") return `binary (${body.file.src || "no file"})`;
	return `${body.mode} (${body.content || ""})`;
}

/** A stable, human-readable rendering of an elements list, for the diff only. */
function describeElements(elements: ElementDef[] | undefined): string {
	const enabled = (elements ?? []).filter((e) => e.enabled);
	if (enabled.length === 0) return "none";
	return enabled.map((e) => e.name ?? e.kind).join(", ");
}

/** A stored header-name list (issue #1765), for the diff only. */
function describeHeaderNames(names: readonly string[] | undefined): string {
	return names && names.length > 0 ? names.join(", ") : "none";
}

/** Right-aligned label for a key/value field: "2 removed", "1 changed", "3 changes". */
function entriesLabel(entries: EntryChange[]): string {
	const kinds = new Set(entries.map((e) => e.kind));
	const n = entries.length;
	if (kinds.size === 1) {
		const word = [...kinds][0]; // added | removed | changed
		return `${n} ${word}`;
	}
	return `${n} ${pluralize(n, "change")}`;
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
	return `${changed} ${pluralize(changed, "line")}`;
}

/**
 * The Auth row, always kept, as a run stores the mode only. Drift is shown only when it is a real
 * comparison: an `inherit` request resolves to a concrete mode at send time, so the run records
 * that result, and `inherit -> none` would read as a change that is not one. So an `inherit`
 * request just shows its mode, kept; two differing concrete modes (request `bearer`, run `basic`)
 * are genuine drift.
 */
function authItem(seed: DesignRunSeed, live: Request): ChangesetItem {
	const liveMode = live.auth?.mode || "none";
	const runMode = seed.recordedAuthMode || "none";
	const comparable = liveMode !== "inherit";

	if (!comparable || liveMode === runMode) {
		return {
			field: "Auth",
			state: "kept",
			detail: "kept",
			value: liveMode,
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
 * The whole confirmation as one list: every field a Save touches is a row, in the order the request
 * stores them, plus Auth (always kept) and, for a run stored before per-part scripts, Scripts
 * (kept). Fields that already match the run are left out, so an unchanged save shows only the kept
 * rows.
 *
 * The rows a pre-#1229 client added (`userEntries`) are stripped from the patch and the comparison,
 * so a stale `X-Vayu-Version` / `X-Request-ID` never appears as a change.
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
	if (seed.withheld.url) {
		items.push(keptItem("URL", live.url, WITHHELD_URL_NOTE));
	} else {
		scalar("URL", live.url, patch.url ?? live.url);
	}
	if (seed.withheld.params) {
		items.push(keptItem("Params", describeEntries(live.params ?? []), WITHHELD_PARAMS_NOTE));
	} else {
		keyValues("Params", paramsForDiff(live.params ?? []), paramsForDiff(patch.params ?? []));
	}
	keyValues("Headers", live.headers ?? [], patch.headers ?? []);
	if (seed.withheld.headers.length > 0) {
		items.push(
			keptItem("Withheld headers", seed.withheld.headers.join(", "), WITHHELD_HEADERS_NOTE)
		);
	}
	// A truncated run stores only a slice of its request body, so the body is not
	// written (applyRunToRequest omits it). Shown as a kept row with the reason,
	// the same way Auth is - never silently dropped.
	const bodyNote = unwritableBodyNote(seed);
	if (bodyNote) {
		items.push(keptItem("Body", describeBody(live.body), bodyNote));
	} else {
		scalar("Body", describeBody(live.body), describeBody(patch.body ?? live.body));
	}

	if (isLegacyRun(seed)) {
		items.push({
			field: "Scripts",
			state: "kept",
			detail: "kept",
			note: "This run predates per-part scripts, so its collection and request scripts are one string that cannot be split apart.",
		});
	} else if (patch.elements !== undefined) {
		// `undefined` means the patch does not write the field, so it is not a change.
		scalar("Elements", describeElements(live.elements), describeElements(patch.elements));
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
	scalar("Protocol", live.httpVersion, patch.httpVersion ?? live.httpVersion);
	scalar(
		"Verify TLS certificate",
		String(live.verifySSL),
		String(patch.verifySSL ?? live.verifySSL)
	);
	scalar(
		"Disable cookie jar",
		String(live.disableCookies),
		String(patch.disableCookies ?? live.disableCookies)
	);
	scalar(
		"Automatic headers left out",
		describeHeaderNames(live.disabledSystemHeaders),
		describeHeaderNames(patch.disabledSystemHeaders ?? live.disabledSystemHeaders)
	);
	scalar(
		"Send URL without encoding",
		String(live.disableUrlEncoding),
		String(patch.disableUrlEncoding ?? live.disableUrlEncoding)
	);

	items.push(authItem(seed, live));

	return items;
}

/**
 * What the run's values fall back to for the fields it can write when the seed has none of its own:
 * the saved request's current values for an update, the defaults for a new request. `body` is the
 * saved request's, for what a run does not record of it.
 */
type WriteFallback = Pick<
	Request,
	| "method"
	| "followRedirects"
	| "maxRedirects"
	| "httpVersion"
	| "verifySSL"
	| "disableCookies"
	| "disabledSystemHeaders"
	| "disableUrlEncoding"
	| "elements"
> & { url: string; body?: RequestBody };

/** What a request created from a run starts from where the run says nothing. */
const NEW_REQUEST_FALLBACK: WriteFallback = {
	method: "GET",
	url: "",
	followRedirects: DEFAULT_FOLLOW_REDIRECTS,
	maxRedirects: DEFAULT_MAX_REDIRECTS,
	httpVersion: DEFAULT_HTTP_VERSION,
	verifySSL: DEFAULT_VERIFY_SSL,
	disableCookies: DEFAULT_DISABLE_COOKIES,
	disabledSystemHeaders: [],
	disableUrlEncoding: DEFAULT_DISABLE_URL_ENCODING,
	elements: [],
};

/** The fields a run can write, as both an update and a create state them. */
type RunWritable = Pick<
	Partial<CreateRequestRequest>,
	| "url"
	| "params"
	| "headers"
	| "body"
	| "bodyType"
	| "elements"
	| "followRedirects"
	| "maxRedirects"
	| "httpVersion"
	| "verifySSL"
	| "disableCookies"
	| "disabledSystemHeaders"
	| "disableUrlEncoding"
> & { method: string };

/**
 * The elements a save writes: the run's own, merged into the saved request's order, plus every
 * saved element the run does not hold. A run stores only what its send ran, and a send leaves out
 * disabled and incomplete elements, so writing the run's list alone would delete them from a
 * request the user never touched. An id the run also holds is the run's version, in the saved
 * element's place; a run-only element goes last.
 */
function elementsToWrite(own: ElementDef[], saved: ElementDef[] | undefined): ElementDef[] {
	const ran = new Map(own.map((e) => [e.id, e]));
	const merged = (saved ?? []).map((e) => ran.get(e.id) ?? e);
	const held = new Set(merged.map((e) => e.id));
	return [...merged, ...own.filter((e) => !held.has(e.id))];
}

/**
 * The fields a run may write, with everything {@link applyRunToRequest}'s rules exclude already
 * excluded: one definition for the update and for a request created from the run, so the two cannot
 * disagree on what is safe. No `auth` key at all, not `auth: undefined`, which some callers would
 * still serialise.
 */
function writableFields(seed: DesignRunSeed, fallback: WriteFallback): RunWritable {
	// `timeout` is deliberately not among them (#2937): the one stored setting whose absence means
	// something ("use the `defaultTimeout` setting"), and a run replays the number a send used,
	// which can be an ad-hoc override from a script or an MCP client. Writing it would pin that
	// number onto a request that states none.
	const request = seed.request;
	const body = bodyFromSeed(
		request,
		fallback.body?.mode === "mcp" ? fallback.body.mcpTool : undefined
	);

	const patch: RunWritable = {
		method: request.method ?? fallback.method,
		// The rows a pre-#1229 client added are dropped, not persisted: the engine adds those
		// headers at send time, and writing a run's stale X-Vayu-Version / X-Request-ID back would
		// pin an old version onto the request.
		headers: userEntries(items(request.headers)),
		followRedirects: request.followRedirects ?? fallback.followRedirects,
		maxRedirects: request.maxRedirects ?? fallback.maxRedirects,
		httpVersion: request.httpVersion ?? fallback.httpVersion,
		verifySSL: request.verifySSL ?? fallback.verifySSL,
		disableCookies: request.disableCookies ?? fallback.disableCookies,
		disabledSystemHeaders: request.disabledSystemHeaders ?? fallback.disabledSystemHeaders,
		disableUrlEncoding: request.disableUrlEncoding ?? fallback.disableUrlEncoding,
	};

	// A url or params holding the withheld marker is left off the patch the same
	// way; params are parsed from the url, so the seed flags them with it.
	if (!seed.withheld.url) patch.url = request.url ?? fallback.url;
	if (!seed.withheld.params) patch.params = items(request.params);

	// The body is written only when the run's stored request body was not truncated: a slice
	// written back would silently corrupt the saved request, so the body (and bodyType) are left
	// off the patch entirely, as auth always is. No `body: undefined` either, which some
	// serialisers would still send.
	if (!unwritableBodyNote(seed)) {
		patch.body = body;
		patch.bodyType = body.mode;
	}

	if (!isLegacyRun(seed)) {
		patch.elements = elementsToWrite(request.elements ?? [], fallback.elements);
	}

	return patch;
}

/** The update payload for the saved request. */
export function applyRunToRequest(seed: DesignRunSeed, live: Request): UpdateRequestRequest {
	return { id: live.id, ...writableFields(seed, live) };
}

/**
 * The fields of a request created from a run with no saved request: what {@link applyRunToRequest}
 * would write, minus the destination and the name, which the caller supplies. A url the engine
 * withheld becomes an empty one, as a new request has no stored value to keep.
 */
export function createFieldsFromRun(
	seed: DesignRunSeed
): Omit<CreateRequestRequest, "collectionId" | "id" | "name"> {
	const { url, ...fields } = writableFields(seed, NEW_REQUEST_FALLBACK);
	return { ...fields, url: url ?? NEW_REQUEST_FALLBACK.url };
}
