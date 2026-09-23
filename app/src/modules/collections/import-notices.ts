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
 * - `action` (red): a request will not work as imported, or something the user
 *   would send is missing.
 * - `note` (muted): the import made a choice or changed a shape; the request
 *   works.
 * - hidden: nothing the user sends or edits differs. Still counted in
 *   `meta.skipped` (the engine's answer, and MCP's), just not shown.
 *
 * Where the engine names the requests a count applies to (`requests`), the
 * line names them too, so "1 request body..." becomes the request to open.
 */

import type { ImportMeta, SkippedItem } from "@/services/importers/types";

export type NoticeTier = "action" | "note";

export interface ImportNotice {
	tier: NoticeTier;
	text: string;
}

interface Copy {
	tier: NoticeTier | "hidden";
	/** Read after "<Request name>: " and after "N requests: ". */
	named?: string;
	/** The count form, for a line with no request names. */
	one: string;
	many: string;
}

/** How many request names a line spells out before "+N more". */
const NAMES_SHOWN = 3;

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
	file_body: {
		tier: "action",
		named: "body not imported (file upload)",
		one: "1 request body not imported (file upload)",
		many: "{n} request bodies not imported (file upload)",
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
		one: "1 referenced file could not be read - its bodies are empty",
		many: "{n} referenced files could not be read - their bodies are empty",
	},
	// The request imports whole; only its sync identity is its path.
	duplicate_operation_id: HIDDEN,
	webhook_operations: {
		tier: "note",
		one: "1 webhook skipped (the API calls you, not the reverse)",
		many: "{n} webhooks skipped (the API calls you, not the reverse)",
	},
	deprecated_operation: HIDDEN,
	cookie_param: {
		tier: "action",
		named: "cookie not imported - add it to the cookie jar",
		one: "1 cookie parameter not imported - use the cookie jar",
		many: "{n} cookie parameters not imported - use the cookie jar",
	},
	// XML imports as `xml`; what reaches this is a binary or image body.
	unmapped_body: {
		tier: "action",
		named: "body not imported (binary file)",
		one: "1 request body not imported (binary file)",
		many: "{n} request bodies not imported (binary file)",
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
		named: "imported without auth (Hawk, OAuth 1 and EdgeGrid are not supported)",
		one: "1 request imported without auth (Hawk, OAuth 1 and EdgeGrid are not supported)",
		many: "{n} requests imported without auth (Hawk, OAuth 1 and EdgeGrid are not supported)",
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
		named: "API key goes in a cookie - add it to the cookie jar",
		one: "1 request sends its API key in a cookie - add it to the cookie jar",
		many: "{n} requests send their API key in a cookie - add it to the cookie jar",
	},
	// A stale `state` is regenerated and a stashed token is fetched again by the grant.
	oauth2_dropped_field: HIDDEN,
	// The value survives as a collection variable.
	path_variables: HIDDEN,
	url_without_raw: HIDDEN,
	invalid_percent_encoding: {
		tier: "note",
		named: "query value with a bad % escape was re-encoded",
		one: "1 query value with a bad % escape was re-encoded",
		many: "{n} query values with bad % escapes were re-encoded",
	},
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

/**
 * A request name as a line quotes it. Spec summaries are often sentences
 * ("Uploads an image."), and a period before the colon reads as a typo.
 */
function quoted(name: string): string {
	return name.replace(/\.+$/, "");
}

/** "Find pet by ID: ..." or "3 requests: ... - A, B, C, +2 more". */
function named(phrase: string, requests: readonly string[]): string {
	const names = requests.map(quoted);
	if (names.length === 1) return `${names[0]}: ${phrase}`;
	const shown = names.slice(0, NAMES_SHOWN).join(", ");
	const rest = names.length - NAMES_SHOWN;
	return `${names.length} requests: ${phrase} - ${shown}${rest > 0 ? `, +${rest} more` : ""}`;
}

function skippedNotice(item: SkippedItem): ImportNotice | null {
	const copy = copyOf(item.kind);
	if (copy.tier === "hidden") return null;
	const text =
		copy.named && item.requests && item.requests.length > 0
			? named(copy.named, item.requests)
			: counted(copy, item.count);
	return { tier: copy.tier, text };
}

/**
 * The lines a preview shows for one parsed file, actions first. Shared by the
 * single-file preview and every batch ledger row, so one file is described in
 * the same words wherever it appears.
 */
export function importNotices(meta: ImportMeta): ImportNotice[] {
	const notices: ImportNotice[] = [];
	for (const item of meta.skipped) {
		const notice = skippedNotice(item);
		if (notice) notices.push(notice);
	}
	// An OpenAPI upload imports as a file row with nothing attached (#425).
	if (meta.unattachedFileParts > 0) {
		notices.push({
			tier: "action",
			text:
				meta.unattachedFileParts === 1
					? "1 file field needs a file"
					: `${meta.unattachedFileParts} file fields need files`,
		});
	}
	if (meta.nonExecutableAuth > 0) {
		const phrase = "auth imported but not sent (AWS, Digest and NTLM are not supported)";
		notices.push({
			tier: "action",
			text:
				meta.nonExecutableAuthRequests && meta.nonExecutableAuthRequests.length > 0
					? named(phrase, meta.nonExecutableAuthRequests)
					: meta.nonExecutableAuth === 1
						? `1 request's ${phrase}`
						: `${meta.nonExecutableAuth} requests' ${phrase}`,
		});
	}
	// Path grouping builds a tree the document never spelled out (#710); a
	// mixed tree is visible above and needs no rule stated.
	if (meta.folderStrategy === "paths") {
		notices.push({ tier: "note", text: "Folders grouped by URL path (the spec has no tags)" });
	}
	return [
		...notices.filter((n) => n.tier === "action"),
		...notices.filter((n) => n.tier === "note"),
	];
}
