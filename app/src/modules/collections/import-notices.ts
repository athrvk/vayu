/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What an import preview tells the user about a file, one line per thing.
 *
 * Every line answers "what do I have to do, or what will look different",
 * never "which construct did the parser meet": the reader is deciding whether
 * to import and what to finish by hand afterwards. Three tiers:
 *
 * - `action` (amber): a request will not work as imported, or something the user
 *   would send is missing.
 * - `note` (muted): the import made a choice or changed a shape; the request
 *   works.
 * - hidden: nothing the user sends or edits differs. Still counted in
 *   `meta.skipped` (the engine's answer, and MCP's), just not shown.
 *
 * Where the engine names the requests a count applies to (`requests`), the
 * line names them too, so "1 request body..." becomes the request to open.
 */

import type {
	CollectionDraft,
	ImportMeta,
	ImportResult,
	RequestDraft,
	SkippedItem,
	UnsupportedScriptApis,
} from "@/services/importers/types";
import { pluralize } from "@/modules/dashboard/utils/format";
import { containsVariableToken } from "@/constants/variables";
import { isBlankScriptElement } from "@/lib/elements";
import { formatNumber } from "@/lib/format-number";
import { parentFolder } from "@/lib/file-path";

export type NoticeTier = "action" | "note";

/** A key `window.electronAPI.openAppLink` accepts; the main process owns the URL behind it. */
export type AppLinkKey = Parameters<NonNullable<Window["electronAPI"]>["openAppLink"]>[0];

export interface ImportNotice {
	tier: NoticeTier;
	text: string;
	/** Where the user reads more, opened in the system browser through the keyed channel. */
	link?: { label: string; key: AppLinkKey };
}

interface Copy {
	tier: NoticeTier | "hidden";
	/** Read after "<Request name>: " and after "N requests: ". */
	named?: string;
	/** What the plural "N ...:" prefix counts when the names are not all requests. */
	owners?: string;
	/** The count form, for a line with no request names. */
	one: string;
	many: string;
}

/*
 * A phrase may hold `{names}`: the item's `names` (the parameter keys a count
 * dropped, never their values) as " (a, b, c)", or nothing when it has none.
 */

/** How many request names a line spells out before "+N more". */
const NAMES_SHOWN = 3;

/** How many folder names the "set on" clause of the unsent-auth line spells out. */
const AUTH_FOLDERS_SHOWN = 5;

/** How many script API names a line spells out before "+N more". */
const API_NAMES_SHOWN = 4;

const HIDDEN: Copy = { tier: "hidden", one: "", many: "" };

/** Every `security_unmapped_*` kind but two is the same outcome: the request uses the collection's auth. */
function collectionAuth(reason: string): Copy {
	return {
		tier: "note",
		named: `uses collection auth (${reason})`,
		one: `1 request uses collection auth (${reason})`,
		many: `{n} requests use collection auth (${reason})`,
	};
}

const COPY: Partial<Record<string, Copy>> = {
	websocket: {
		tier: "action",
		named: "WebSocket request not imported",
		one: "1 WebSocket request not imported",
		many: "{n} WebSocket requests not imported",
	},
	grpc: {
		tier: "action",
		named: "gRPC request not imported",
		one: "1 gRPC request not imported",
		many: "{n} gRPC requests not imported",
	},
	api_spec: {
		tier: "note",
		named: "embedded API spec not imported - import it as its own file",
		one: "1 embedded API spec not imported - import it as its own file",
		many: "{n} embedded API specs not imported - import them as their own files",
	},
	unit_test: {
		tier: "note",
		named: "Insomnia unit test not imported",
		one: "1 Insomnia unit test not imported",
		many: "{n} Insomnia unit tests not imported",
	},
	// A whole-file body imports as a `binary` body now, with the path the
	// source named; the folder lines below are where the user acts on one the
	// engine would refuse, so this line only says what arrived.
	file_body: {
		tier: "note",
		named: "file body imported - choose the file or allow its folder to send it",
		one: "1 file body imported - choose the file or allow its folder to send it",
		many: "{n} file bodies imported - choose each file or allow its folder to send them",
	},
	malformed_item: {
		tier: "action",
		one: "1 invalid item skipped",
		many: "{n} invalid items skipped",
	},
	// Named only by the Postman walk, which sends the request as GET; an
	// OpenAPI operation with a method Vayu has no verb for is not imported.
	unsupported_method: {
		tier: "action",
		named: "method not supported - imported as GET",
		one: "1 operation with an unsupported method not imported",
		many: "{n} operations with unsupported methods not imported",
	},
	malformed_spec: {
		tier: "action",
		one: "1 invalid section of the spec skipped",
		many: "{n} invalid sections of the spec skipped",
	},
	example_no_status: {
		tier: "note",
		named: "example skipped (no status code)",
		one: "1 example skipped (no status code)",
		many: "{n} examples skipped (no status code)",
	},
	// Every vendor spec declares one on every operation (issue #710); nothing
	// the user would send depends on it.
	default_response: HIDDEN,
	external_ref: {
		tier: "action",
		one: "1 referenced file couldn't be read - its bodies are empty",
		many: "{n} referenced files couldn't be read - their bodies are empty",
	},
	// The request imports whole; only its sync identity is its path.
	duplicate_operation_id: HIDDEN,
	webhook_operations: {
		tier: "note",
		one: "1 webhook skipped (the API calls you, not the reverse)",
		many: "{n} webhooks skipped (the API calls you, not the reverse)",
	},
	deprecated_operation: HIDDEN,
	// Not "the cookie jar": nothing in the app adds a cookie to it (it fills from
	// responses and `pm.cookies.jar()`), so a header is what the user can write.
	cookie_param: {
		tier: "action",
		named: "cookie not imported - add it as a Cookie header",
		one: "1 cookie parameter not imported - add it as a Cookie header",
		many: "{n} cookie parameters not imported - add them as a Cookie header",
	},
	// XML imports as `xml`; what reaches this is a binary or image body.
	unmapped_body: {
		tier: "action",
		named: "body not imported (unsupported media type)",
		one: "1 request body not imported (unsupported media type)",
		many: "{n} request bodies not imported (unsupported media type)",
	},
	unresolved_base_url: {
		tier: "action",
		one: "Base URL is incomplete - set it in the collection",
		many: "Base URL is incomplete - set it in the collection",
	},
	servers_dropped: {
		tier: "note",
		one: "1 other server URL ignored - only the first is used",
		many: "{n} other server URLs ignored - only the first is used",
	},
	unsupported_auth: {
		tier: "action",
		named: "imported without auth (an auth type Vayu does not recognise)",
		one: "1 request imported without auth (an auth type Vayu does not recognise)",
		many: "{n} requests imported without auth (an auth type Vayu does not recognise)",
	},
	security_unmapped_or: collectionAuth("the spec allows several"),
	security_unmapped_and: collectionAuth("the spec wants several at once"),
	security_unmapped_scheme: collectionAuth("its scheme is missing from the spec"),
	security_unmapped_type: collectionAuth("auth type not supported"),
	security_unmapped_openidconnect: collectionAuth("OpenID Connect is not supported"),
	security_unmapped_mutualtls: {
		tier: "action",
		named: "needs a client certificate - add one in Settings",
		one: "1 request needs a client certificate - add one in Settings",
		many: "{n} requests need a client certificate - add one in Settings",
	},
	security_unmapped_apikey_cookie: {
		tier: "action",
		named: "API key goes in a cookie - add it as a Cookie header",
		one: "1 request sends its API key in a cookie - add it as a Cookie header",
		many: "{n} requests send their API key in a cookie - add it as a Cookie header",
	},
	// Vayu generates a fresh `state` for every authorization attempt.
	oauth2_state_regenerated: HIDDEN,
	// The token Postman had fetched is not a setting to carry over: the grant
	// fetches a new one the first time the request needs it.
	oauth2_dropped_field: {
		tier: "note",
		named: "saved OAuth 2.0 token not imported - Vayu fetches a new one through the grant",
		one: "1 saved OAuth 2.0 token not imported - Vayu fetches a new one through the grant",
		many: "{n} saved OAuth 2.0 tokens not imported - Vayu fetches new ones through the grant",
	},
	// Sent by the engine itself (scope, client_id ...) or with no place to go; a
	// provider that needs one (an audience, an acr_values) refuses the request.
	oauth2_unmapped_param: {
		tier: "action",
		named: "OAuth 2.0 request parameter not imported{names} - Vayu sets some itself and cannot place the rest",
		one: "1 OAuth 2.0 request parameter not imported{names} - Vayu sets some itself and cannot place the rest",
		many: "{n} OAuth 2.0 request parameters not imported{names} - Vayu sets some itself and cannot place the rest",
	},
	url_without_raw: HIDDEN,
	variable_metadata: HIDDEN,
	disabled_body: {
		tier: "note",
		named: "body left out (disabled in Postman)",
		one: "1 body left out (disabled in Postman)",
		many: "{n} bodies left out (disabled in Postman)",
	},
	certificate: {
		tier: "action",
		named: "client certificate not imported - add it in Settings",
		one: "1 client certificate not imported - add it in Settings",
		many: "{n} client certificates not imported - add them in Settings",
	},
	proxy_config: {
		tier: "note",
		named: "its own proxy setting not imported",
		one: "1 per-request proxy setting not imported",
		many: "{n} per-request proxy settings not imported",
	},
	protocol_behavior: {
		tier: "note",
		named: "Postman request setting kept but not applied (e.g. TLS options, Host header)",
		one: "1 request's Postman setting kept but not applied (e.g. TLS options, Host header)",
		many: "{n} requests' Postman settings kept but not applied (e.g. TLS options, Host header)",
	},
	// The engine names whoever declares the script, which is a folder or the
	// collection as often as a request, so the plural prefix counts "items".
	script_unsupported: {
		tier: "action",
		owners: "items",
		named: "script not imported (loaded from a URL, or on an event Vayu has no phase for) - add it as a pre-request or test script",
		one: "1 script not imported (loaded from a URL, or on an event Vayu has no phase for) - add it as a pre-request or test script",
		many: "{n} scripts not imported (loaded from a URL, or on an event Vayu has no phase for) - add them as pre-request or test scripts",
	},
	// The engine names the folder or collection under `names`, not `requests`:
	// the line is about the node that declared the setting.
	protocol_behavior_folder: {
		tier: "note",
		one: "1 folder or collection has a Postman setting Vayu does not apply or carry (e.g. TLS options){names}",
		many: "{n} folders or collections have Postman settings Vayu does not apply or carry (e.g. TLS options){names}",
	},
	// Postman prunes a GET or HEAD body unless the request opts out; Vayu sends
	// what the Body tab holds, so the request behaves differently until the
	// body is cleared (#2540).
	body_on_get: {
		tier: "action",
		named: "GET or HEAD body kept - Postman does not send it, Vayu will; clear the body to match",
		one: "1 GET or HEAD body kept - Postman does not send it, Vayu will; clear it to match",
		many: "{n} GET or HEAD bodies kept - Postman does not send them, Vayu will; clear them to match",
	},
	elements_invalid: {
		tier: "action",
		named: "script or check dropped (invalid)",
		one: "1 script or check dropped (invalid)",
		many: "{n} scripts or checks dropped (invalid)",
	},
	mock_example_missing: {
		tier: "note",
		named: "mock example not found - mocks the first one",
		one: "1 mock example not found - mocks the first one",
		many: "{n} mock examples not found - mock the first one",
	},
	vayu_extension_invalid: {
		tier: "action",
		named: "hand-edited Vayu detail ignored (invalid)",
		one: "1 hand-edited Vayu detail ignored (invalid)",
		many: "{n} hand-edited Vayu details ignored (invalid)",
	},
	nesting_too_deep: {
		tier: "action",
		one: "1 branch nested too deeply (over 100 levels) and left out",
		many: "{n} branches nested too deeply (over 100 levels) and left out",
	},
	"HTTPsampler.Files": {
		tier: "action",
		one: "1 file upload without a field name skipped",
		many: "{n} file uploads without a field name skipped",
	},
	ResponseAssertion_or: {
		tier: "note",
		one: '1 "any of" assertion not imported',
		many: '{n} "any of" assertions not imported',
	},
};

/**
 * A kind with no entry - a JMeter class name, open-ended by nature (issue
 * #1518) - still says something: the class is what a JMeter user sees in
 * their own tree.
 */
function copyOf(kind: SkippedItem["kind"]): Copy {
	const known = COPY[kind];
	if (known) return known;
	// The user switched it off in JMeter themselves.
	if (kind.endsWith("_disabled")) return HIDDEN;
	if (kind.endsWith("_unmappable")) {
		const element = kind.slice(0, -"_unmappable".length);
		return {
			tier: "action",
			one: `1 ${element} element dropped (invalid)`,
			many: `{n} ${element} elements dropped (invalid)`,
		};
	}
	const name = kind.endsWith("_unrecognised") ? kind.slice(0, -"_unrecognised".length) : kind;
	return { tier: "note", one: `1 ${name} not imported`, many: `{n} ${name} not imported` };
}

function counted(copy: Copy, count: number): string {
	return count === 1 ? copy.one : copy.many.replace("{n}", String(count));
}

/** " (a, b, c, +2 more)" for the keys an item names, "" for none. */
function namesClause(names: readonly string[] | undefined): string {
	if (!names || names.length === 0) return "";
	const rest = names.length - NAMES_SHOWN;
	const shown = names.slice(0, NAMES_SHOWN).join(", ");
	return ` (${shown}${rest > 0 ? `, +${rest} more` : ""})`;
}

/**
 * A request name as a line quotes it. Spec summaries are often sentences
 * ("Uploads an image."), and a period before the colon reads as a typo.
 */
function quoted(name: string): string {
	return name.replace(/\.+$/, "");
}

/** "A, B, C, +2 more": the first @p limit items, then how many were left out. */
function listed(items: readonly string[], limit: number): string {
	const rest = items.length - limit;
	return `${items.slice(0, limit).join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
}

/** "Find pet by ID: ..." or "3 requests: ... - A, B, C, +2 more". */
function named(phrase: string, requests: readonly string[], noun = "requests"): string {
	const names = requests.map(quoted);
	if (names.length === 1) return `${names[0]}: ${phrase}`;
	return `${names.length} ${noun}: ${phrase} - ${listed(names, NAMES_SHOWN)}`;
}

function skippedNotice(item: SkippedItem): ImportNotice | null {
	const copy = copyOf(item.kind);
	if (copy.tier === "hidden") return null;
	const text =
		copy.named && item.requests && item.requests.length > 0
			? named(copy.named, item.requests, copy.owners)
			: counted(copy, item.count);
	return { tier: copy.tier, text: text.replace("{names}", namesClause(item.names)) };
}

/**
 * The `$ref`s the bundling did not follow (refused, or answered for by the
 * engine), each by name, and the remote documents it pulled in - a spec from
 * the internet decides what gets inlined, so the user sees both before applying
 * (#1782).
 */
function refReportNotices(report: ImportMeta["refReport"]): ImportNotice[] {
	if (!report) return [];
	const notices: ImportNotice[] = report.refused.map(({ target, reason }) => ({
		tier: "action",
		text: `Reference not followed: ${target} (${reason})`,
	}));
	if (report.fetched.length > 0) {
		notices.push({ tier: "note", text: `Fetched from: ${report.fetched.join(", ")}` });
	}
	return notices;
}

/**
 * "set on the collection and folders A, B": where the unsent auth is declared,
 * which the request line cannot say - the requests it counts mostly inherit it
 * (#2537). "" when the engine named no declaring site.
 */
function authDeclaredOn(meta: ImportMeta): string {
	const folders = meta.nonExecutableAuthFolders ?? [];
	const sites = [
		meta.nonExecutableAuthCollection !== undefined && "the collection",
		folders.length > 0 &&
			`${pluralize(folders.length, "folder")} ${listed(folders, AUTH_FOLDERS_SHOWN)}`,
	].filter((site): site is string => typeof site === "string");
	return sites.length > 0 ? `; set on ${sites.join(" and ")}` : "";
}

/**
 * The line for requests whose auth imports but is never sent: the requests
 * that lose it, then where it was declared. The count is of requests, so a
 * collection that only declares it on a folder nothing inherits from shows
 * no line at all.
 */
function nonExecutableAuthNotice(meta: ImportMeta): ImportNotice {
	const phrase =
		"auth imported but not sent (Vayu does not sign AWS, Digest, NTLM, Hawk, OAuth 1, EdgeGrid or JWT)";
	const requests = meta.nonExecutableAuthRequests;
	const lead =
		requests && requests.length > 0
			? named(phrase, requests)
			: `${meta.nonExecutableAuth} ${pluralize(meta.nonExecutableAuth, "request's", "requests'")} ${phrase}`;
	return { tier: "action", text: lead + authDeclaredOn(meta) };
}

/**
 * The scripts that import but throw at first run (#2576): one amber line naming
 * the requests and, as a union, the APIs. The import is not blocked, and the
 * engine names only scripts it imported, so the import-scripts option needs no
 * handling here.
 */
function unsupportedScriptApiNotice(
	entries: readonly UnsupportedScriptApis[] | undefined
): ImportNotice | null {
	if (!entries || entries.length === 0) return null;
	const apis = [...new Set(entries.flatMap((entry) => entry.names))];
	const phrase = `script uses APIs Vayu does not run yet${apis.length > 0 ? ` (${listed(apis, API_NAMES_SHOWN)})` : ""}`;
	return {
		tier: "action",
		text: named(
			phrase,
			entries.map((entry) => entry.request)
		),
		link: { label: "See what Vayu supports", key: "pmApiCompatibility" },
	};
}

/**
 * The count line under a parsed file, shared by the single-file preview and
 * every batch row.
 *
 * `ImportMeta` names no format family, so the shape is read off the counts: a
 * file with no requests and no folders that carries environments or globals is
 * an environment export, and "0 requests" would be noise there. Anything else
 * is a collection or spec, where "0 examples" is an answer (#481) and an
 * environment segment appears only when there is one to report.
 */
export function describeCounts(meta: ImportMeta): string {
	const count = (n: number, noun: string) => `${formatNumber(n)} ${pluralize(n, noun)}`;
	const environmentSegments = [
		meta.environmentCount > 0 && count(meta.environmentCount, "environment"),
		meta.globalCount > 0 && count(meta.globalCount, "global"),
	].filter((segment): segment is string => segment !== false);
	const environmentOnly =
		meta.requestCount === 0 && meta.folderCount === 0 && environmentSegments.length > 0;
	if (environmentOnly) return environmentSegments.join(" · ");
	return [
		count(meta.requestCount, "request"),
		count(meta.folderCount, "nested collection"),
		count(meta.exampleCount, "example"),
		...environmentSegments,
	].join(" · ");
}

/**
 * The engine's `certificate` tally plus the resolved candidates the user left
 * unticked (#2363): both are certificates the import did not register, and the
 * fix is the same - add it in Settings. The request names the engine attached
 * are dropped once there are unticked ones, since they would name fewer
 * requests than the line counts.
 */
function withUnticked(skipped: readonly SkippedItem[], unticked: number): readonly SkippedItem[] {
	if (unticked === 0) return skipped;
	if (!skipped.some((item) => item.kind === "certificate")) {
		return [...skipped, { kind: "certificate", count: unticked }];
	}
	return skipped.map((item) =>
		item.kind === "certificate" ? { kind: item.kind, count: item.count + unticked } : item
	);
}

/**
 * The lines a preview shows for one parsed file, actions first. Shared by the
 * single-file preview and every batch ledger row, so one file is described in
 * the same words wherever it appears.
 *
 * @param unticked client-certificate candidates in this file the apply will not
 * register (`unselectedCertificateCount`), tallied beside the engine's own.
 */
export function importNotices(meta: ImportMeta, unticked = 0): ImportNotice[] {
	const notices: ImportNotice[] = [];
	for (const item of withUnticked(meta.skipped, unticked)) {
		const notice = skippedNotice(item);
		if (notice) notices.push(notice);
	}
	notices.push(...refReportNotices(meta.refReport));
	// An OpenAPI upload imports as a file row with nothing attached (#425).
	if (meta.unattachedFileParts > 0) {
		const n = meta.unattachedFileParts;
		notices.push({
			tier: "action",
			text: `${n} ${pluralize(n, "file field")} ${pluralize(n, "needs", "need")} ${pluralize(n, "a file", "files")}`,
		});
	}
	if (meta.nonExecutableAuth > 0) notices.push(nonExecutableAuthNotice(meta));
	const scriptApis = unsupportedScriptApiNotice(meta.unsupportedScriptApis);
	if (scriptApis) notices.push(scriptApis);
	// Path grouping builds a tree the document never spelled out (#710); a
	// mixed tree is visible above and needs no rule stated.
	if (meta.folderStrategy === "paths") {
		notices.push({
			tier: "note",
			text: "Collections grouped by URL path (the spec has no tags)",
		});
	}
	return [
		...notices.filter((n) => n.tier === "action"),
		...notices.filter((n) => n.tier === "note"),
	];
}

/** Distinct folders holding imported file references, and how many each holds. */
export interface FileReferenceFolder {
	folder: string;
	count: number;
}

export interface FileReferenceNeeds {
	folders: FileReferenceFolder[];
	bodiesWithoutFile: number;
}

/**
 * What an import's file references need before they can be sent, read off the
 * drafts themselves rather than a counter, so every format answers alike.
 *
 * - `folders`: the paths `POST /import/parse` answered `unresolved` - the
 *   engine's derived answer that it would refuse them on this machine, being
 *   neither picked here nor under an allowed folder (#2356). One entry per
 *   distinct parent folder, so a collection exported on this same machine is
 *   one "Allow folder" choice rather than a relink per request. A path with a
 *   `{{variable}}` in its folder names no folder yet and is left out.
 * - `bodiesWithoutFile`: `binary` bodies that arrived with no path at all (an
 *   OpenAPI upload documents the type, never the file). Form-data parts in the
 *   same state are the engine's `unattachedFileParts`, already a line of its
 *   own; this is the whole-body counterpart.
 */
export function fileReferenceNeeds(results: readonly ImportResult[]): FileReferenceNeeds {
	const counts = new Map<string, number>();
	let bodiesWithoutFile = 0;

	const reference = (src: string | undefined, unresolved: boolean | undefined) => {
		if (!unresolved || !src?.trim()) return;
		const folder = parentFolder(src);
		if (!folder || containsVariableToken(folder)) return;
		counts.set(folder, (counts.get(folder) ?? 0) + 1);
	};
	const visitRequest = (request: RequestDraft) => {
		const body = request.body;
		if (body?.mode === "binary") {
			if (!body.file?.src?.trim()) bodiesWithoutFile += 1;
			else reference(body.file.src, body.file.unresolved);
		} else if (body?.mode === "form-data") {
			for (const field of body.fields ?? []) {
				if (field.type === "file") reference(field.src, field.unresolved);
			}
		}
	};
	const visit = (collection: CollectionDraft) => {
		collection.requests.forEach(visitRequest);
		collection.children.forEach(visit);
	};
	for (const result of results) result.collections.forEach(visit);

	const folders = [...counts]
		.map(([folder, count]) => ({ folder, count }))
		.sort((a, b) => a.folder.localeCompare(b.folder));
	return { folders, bodiesWithoutFile };
}

/** The line for `bodiesWithoutFile`, in the words the form-part line uses. */
export function bodiesWithoutFileNotice(n: number): ImportNotice | null {
	if (n === 0) return null;
	return {
		tier: "action",
		text: `${n} ${pluralize(n, "file body", "file bodies")} ${pluralize(n, "needs", "need")} ${pluralize(n, "a file", "files")}`,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** `elements` is `unknown[]` on a draft (#1516); a script is the one kind read here. */
function isRunnableScript(element: unknown): boolean {
	if (!isRecord(element) || typeof element.kind !== "string" || !isRecord(element.config)) {
		return false;
	}
	if (element.kind !== "script.pre" && element.kind !== "script.post") return false;
	if (element.enabled === false) return false;
	return !isBlankScriptElement({ kind: element.kind, config: element.config });
}

const NO_AUTH_MODES: readonly string[] = ["none", "noauth", "inherit"];

interface CarriedOver {
	variables: number;
	requestsWithAuth: number;
	requestsWithScripts: number;
}

function tallyCarriedOver(results: readonly ImportResult[]): CarriedOver {
	const tally: CarriedOver = { variables: 0, requestsWithAuth: 0, requestsWithScripts: 0 };
	const visit = (collection: CollectionDraft) => {
		tally.variables += Object.keys(collection.variables).length;
		for (const request of collection.requests) {
			if (!NO_AUTH_MODES.includes(request.auth.mode)) tally.requestsWithAuth += 1;
			// The engine leaves `elements` off a request that has none, whatever the type says.
			if ((request.elements ?? []).some(isRunnableScript)) tally.requestsWithScripts += 1;
		}
		collection.children.forEach(visit);
	};
	for (const result of results) result.collections.forEach(visit);
	return tally;
}

/**
 * What survived the import beyond names and URLs, read off the drafts like
 * `fileReferenceNeeds` so every format answers alike: collection variables,
 * and the requests that carry their own auth or a script that will run.
 *
 * - auth: a request with a mode other than none, noauth or inherit; a request
 *   that inherits is not counted, its collection's auth is not a request's.
 * - scripts: an enabled, non-blank `script.pre` / `script.post` element.
 *
 * An empty string when none of the three is present, so the caller renders
 * nothing rather than an empty line.
 */
export function describeCarriedOver(results: readonly ImportResult[]): string {
	const { variables, requestsWithAuth, requestsWithScripts } = tallyCarriedOver(results);
	const count = (n: number, noun: string) => `${formatNumber(n)} ${pluralize(n, noun)}`;
	const segments = [
		variables > 0 && count(variables, "variable"),
		requestsWithAuth > 0 && `auth on ${count(requestsWithAuth, "request")}`,
		requestsWithScripts > 0 && `scripts on ${count(requestsWithScripts, "request")}`,
	].filter((segment): segment is string => segment !== false);
	return segments.length > 0 ? `Carried over: ${segments.join(" · ")}` : "";
}
