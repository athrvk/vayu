/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * curl / wget command parser.
 *
 * Detects a pasted curl or wget command and maps it onto the request-builder
 * state. The result is a request-shape replacement: every request field is set
 * (with explicit defaults before flag overrides) so no stale body/auth/header
 * can survive from the previous request. Identity and scripts (`id`, `name`,
 * `collectionId`, `preRequestScript`, `testScript`) are deliberately never
 * included - curl can't express them, so the caller keeps its own.
 *
 * A body read from a file (`-d @body.json`) is still skipped: the contents are
 * the body, and a pasted command cannot supply them. A **form file part**
 * (`-F field=@file`) is different - the engine opens the file at send time, so
 * only its path has to survive, and it imports as a file row marked unresolved
 * (issue #393). Before that it landed as a text field whose value was the
 * literal `@path`.
 */

import type { HttpMethod } from "@/types";
import type { BodyMode, KeyValueItem } from "@/types";
import type { RequestState } from "@/modules/request-builder/types";
import { generateId } from "@/lib/id";
import { fileBaseName } from "@/lib/file-path";
import { parseQueryParams } from "@/modules/request-builder/utils/url";
import { tokenize } from "./tokenize";

/** The subset of RequestState a curl/wget command can populate. */
export type ParsedRequest = Pick<
	RequestState,
	| "method"
	| "url"
	| "params"
	| "headers"
	| "bodyMode"
	| "body"
	| "formData"
	| "urlEncoded"
	| "auth"
>;

type CommandKind = "curl" | "wget";

/** Detect whether pasted text is a curl or wget command. */
export function detectCommand(text: string): CommandKind | null {
	const stripped = text.trim().replace(/^[$>]\s+/, "");
	const first = stripped.split(/\s/, 1)[0]?.toLowerCase();
	if (first === "curl") return "curl";
	if (first === "wget") return "wget";
	return null;
}

/**
 * Parse a pasted curl/wget command into a request-shape partial.
 * Returns null when the text isn't a recognized command or parsing fails -
 * never throws to the caller.
 */
export function parseCommand(text: string): ParsedRequest | null {
	const kind = detectCommand(text);
	if (!kind) return null;

	try {
		const argv = tokenize(text);
		// Drop the leading program name (curl / wget).
		const args = argv.slice(1);
		const parsed = kind === "curl" ? parseCurl(args) : parseWget(args);
		if (!parsed.url) return null;
		return parsed;
	} catch {
		return null;
	}
}

// ============================================================================
// Builder - accumulates state and resolves it into a ParsedRequest
// ============================================================================

interface Builder {
	url: string;
	method: HttpMethod | null;
	headers: Array<{ key: string; value: string }>;
	dataParts: string[]; // -d / --data*
	urlEncodeParts: string[]; // --data-urlencode
	formParts: FormPart[]; // -F
	forceGet: boolean; // -G
	jsonShortcut: boolean; // curl --json
	uploadFile: boolean; // curl -T (implies PUT)
	basic: { username: string; password: string } | null;
	bearer: string | null; // curl --oauth2-bearer
}

function newBuilder(): Builder {
	return {
		url: "",
		method: null,
		headers: [],
		dataParts: [],
		urlEncodeParts: [],
		formParts: [],
		forceGet: false,
		jsonShortcut: false,
		uploadFile: false,
		basic: null,
		bearer: null,
	};
}

/** Is the value a file reference whose *contents* we cannot read (`@path`)? */
function isFileRef(value: string): boolean {
	return value.startsWith("@");
}

function addHeader(b: Builder, raw: string): void {
	const idx = raw.indexOf(":");
	if (idx === -1) return;
	const key = raw.slice(0, idx).trim();
	const value = raw.slice(idx + 1).trim();
	if (key) b.headers.push({ key, value });
}

function setBasicAuth(b: Builder, raw: string): void {
	const idx = raw.indexOf(":");
	if (idx === -1) {
		b.basic = { username: raw, password: "" };
	} else {
		b.basic = { username: raw.slice(0, idx), password: raw.slice(idx + 1) };
	}
}

function toItems(pairs: Array<{ key: string; value: string }>): KeyValueItem[] {
	return pairs.map(({ key, value }) => ({ id: generateId(), key, value, enabled: true }));
}

/**
 * One `-F` part. A file part is `name=@path`, optionally with curl's per-part
 * `;type=` and `;filename=` modifiers - the same three things Vayu's own file
 * row carries, which is why the command round-trips.
 */
interface FormPart {
	key: string;
	value: string;
	src?: string;
	fileName?: string;
	contentType?: string;
}

/**
 * `-F name=@path;type=image/png;filename=avatar.png` → a file part.
 *
 * Before issue #393 this was skipped as unreadable and the row landed as the
 * literal text `@path`: a command that uploaded a file imported as one that
 * posts a path string. The path is kept as written - it names a file on
 * whoever's machine the command came from - and the row is marked unresolved so
 * the editor says so.
 *
 * `<path` (curl's "read the file as the value" form) is deliberately NOT a file
 * part: it means the file's *contents* become the field value, which is a text
 * part whose text this parser cannot read. It stays skipped.
 */
function formPart(key: string, raw: string): FormPart | null {
	if (!raw.startsWith("@")) return { key, value: raw };
	// Modifiers are `;name=value` after the path. A `;` inside a quoted path is
	// not something curl supports either, so splitting on it is faithful.
	const [pathPart, ...modifiers] = raw.slice(1).split(";");
	const src = pathPart.trim();
	if (!src) return null;
	const part: FormPart = { key, value: "", src };
	for (const modifier of modifiers) {
		const eq = modifier.indexOf("=");
		if (eq === -1) continue;
		const name = modifier.slice(0, eq).trim().toLowerCase();
		const setting = modifier.slice(eq + 1).trim();
		if (name === "type") part.contentType = setting;
		if (name === "filename") part.fileName = setting;
	}
	part.fileName ??= fileBaseName(src);
	return part;
}

/** `-F` parts as editor rows, files included. */
function toFormItems(parts: FormPart[]): KeyValueItem[] {
	return parts.map((part) => ({
		id: generateId(),
		key: part.key,
		value: part.value,
		enabled: true,
		...(part.src
			? {
					type: "file" as const,
					src: part.src,
					fileName: part.fileName,
					...(part.contentType ? { contentType: part.contentType } : {}),
					unresolved: true,
				}
			: {}),
	}));
}

function findHeader(b: Builder, name: string): string | undefined {
	const lower = name.toLowerCase();
	return b.headers.find((h) => h.key.toLowerCase() === lower)?.value;
}

function resolve(b: Builder): ParsedRequest {
	// --- URL + params -------------------------------------------------------
	let url = b.url;
	const dataJoined = b.dataParts.join("&");

	// -G moves data onto the query string as params.
	if (b.forceGet && dataJoined) {
		url += (url.includes("?") ? "&" : "?") + dataJoined;
	}
	const params = parseQueryParams(url);

	// --- method -------------------------------------------------------------
	const hasBody = b.dataParts.length > 0 || b.urlEncodeParts.length > 0 || b.jsonShortcut;
	const hasForm = b.formParts.length > 0;
	let method: HttpMethod;
	if (b.method) {
		method = b.method;
	} else if (b.forceGet) {
		method = "GET";
	} else if (b.uploadFile) {
		method = "PUT";
	} else if (hasBody || hasForm) {
		method = "POST";
	} else {
		method = "GET";
	}

	// --- headers + auth -----------------------------------------------------
	const headers = b.headers.slice();
	if (b.jsonShortcut) {
		if (!findHeader(b, "content-type"))
			headers.push({ key: "Content-Type", value: "application/json" });
		if (!findHeader(b, "accept")) headers.push({ key: "Accept", value: "application/json" });
	}

	// Bearer (curl --oauth2-bearer) wins over basic if both are somehow present,
	// mirroring curl sending the last-set Authorization scheme.
	let auth: ParsedRequest["auth"] = { mode: "none" };
	if (b.bearer !== null) {
		auth = { mode: "bearer", token: b.bearer };
	} else if (b.basic) {
		auth = { mode: "basic", username: b.basic.username, password: b.basic.password };
	}

	// --- body ---------------------------------------------------------------
	let bodyMode: BodyMode = "none";
	let body = "";
	let formData: KeyValueItem[] = [];
	let urlEncoded: KeyValueItem[] = [];

	const contentType = (b.jsonShortcut ? "application/json" : findHeader(b, "content-type")) ?? "";

	if (hasForm) {
		bodyMode = "form-data";
		formData = toFormItems(b.formParts);
	} else if (b.urlEncodeParts.length > 0) {
		bodyMode = "x-www-form-urlencoded";
		urlEncoded = toItems(parseFormPairs(b.urlEncodeParts));
	} else if (!b.forceGet && (b.dataParts.length > 0 || b.jsonShortcut)) {
		if (contentType.includes("application/x-www-form-urlencoded")) {
			bodyMode = "x-www-form-urlencoded";
			urlEncoded = toItems(parseFormPairs(b.dataParts));
		} else if (contentType.includes("application/json") || b.jsonShortcut) {
			bodyMode = "json";
			body = dataJoined;
		} else if (looksLikeFormData(dataJoined)) {
			// curl's -d/--data defaults to application/x-www-form-urlencoded on the
			// wire even without an explicit Content-Type header (curl.1). Match that
			// when the data is form-shaped (key=value&…), like Postman/Bruno do, so
			// the fields land as editable rows instead of one opaque text blob.
			bodyMode = "x-www-form-urlencoded";
			urlEncoded = toItems(parseFormPairs(b.dataParts));
		} else {
			// A raw, non-form payload (e.g. a JSON blob or plain text) with no
			// Content-Type - keep it verbatim rather than mangling it into rows.
			bodyMode = "text";
			body = dataJoined;
		}
	}

	return {
		method,
		url,
		params,
		headers: toItems(headers),
		bodyMode,
		body,
		formData,
		urlEncoded,
		auth,
	};
}

/**
 * Does the joined `-d` data look like x-www-form-urlencoded content
 * (`key=value` pairs joined by `&`), as opposed to a raw JSON/text blob?
 * Every `&`-segment must carry a non-empty key before its `=`. A leading
 * `{`/`[` (JSON) short-circuits to false.
 */
function looksLikeFormData(data: string): boolean {
	const trimmed = data.trim();
	if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
	return trimmed
		.split("&")
		.filter(Boolean)
		.every((pair) => pair.indexOf("=") > 0);
}

/** Split `key=value` data parts into pairs (for urlencoded bodies/params). */
function parseFormPairs(parts: string[]): Array<{ key: string; value: string }> {
	const pairs: Array<{ key: string; value: string }> = [];
	for (const part of parts) {
		for (const piece of part.split("&").filter(Boolean)) {
			const idx = piece.indexOf("=");
			if (idx === -1) {
				pairs.push({ key: piece, value: "" });
			} else {
				pairs.push({ key: piece.slice(0, idx), value: piece.slice(idx + 1) });
			}
		}
	}
	return pairs;
}

// ============================================================================
// curl
// ============================================================================

/** curl flags that take no value (we skip them). */
const CURL_NOARG = new Set([
	"--compressed",
	"-s",
	"--silent",
	"-v",
	"--verbose",
	"-L",
	"--location",
	"-k",
	"--insecure",
	"-f",
	"--fail",
	"-S",
	"--show-error",
	"-#",
	"--progress-bar",
	"-O",
	"--remote-name",
	"-j",
	"--junk-session-cookies",
	"-N",
	"--no-buffer",
]);

/** curl flags that take a value we ignore. */
const CURL_SKIP_WITH_ARG = new Set([
	"-o",
	"--output",
	"-w",
	"--write-out",
	"--connect-timeout",
	"-m",
	"--max-time",
	"--retry",
	"--cacert",
	"--cert",
	"--key",
	"-x",
	"--proxy",
	"--resolve",
]);

function parseCurl(args: string[]): ParsedRequest {
	const b = newBuilder();

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = () => args[++i];

		// Split combined `--flag=value` form.
		let flag = arg;
		let inlineValue: string | undefined;
		if (arg.startsWith("--") && arg.includes("=")) {
			const eq = arg.indexOf("=");
			flag = arg.slice(0, eq);
			inlineValue = arg.slice(eq + 1);
		}
		const value = () => inlineValue ?? next();

		switch (flag) {
			case "-X":
			case "--request":
				b.method = value().toUpperCase() as HttpMethod;
				break;
			case "-I":
			case "--head":
				b.method = "HEAD";
				break;
			case "-H":
			case "--header":
				addHeader(b, value());
				break;
			case "-A":
			case "--user-agent":
				b.headers.push({ key: "User-Agent", value: value() });
				break;
			case "-e":
			case "--referer":
				b.headers.push({ key: "Referer", value: value() });
				break;
			case "-b":
			case "--cookie":
				b.headers.push({ key: "Cookie", value: value() });
				break;
			case "-u":
			case "--user":
				setBasicAuth(b, value());
				break;
			case "--oauth2-bearer":
				// curl's dedicated OAuth 2.0 bearer flag → Vayu bearer auth.
				b.bearer = value();
				break;
			case "-d":
			case "--data":
			case "--data-raw":
			case "--data-ascii":
			case "--data-binary": {
				const v = value();
				if (!isFileRef(v)) b.dataParts.push(v);
				break;
			}
			case "--data-urlencode": {
				const v = value();
				if (!isFileRef(v)) b.urlEncodeParts.push(v);
				break;
			}
			case "--json": {
				const v = value();
				if (!isFileRef(v)) b.dataParts.push(v);
				b.jsonShortcut = true;
				break;
			}
			case "-F":
			case "--form": {
				const v = value();
				const idx = v.indexOf("=");
				if (idx !== -1) {
					const part = formPart(v.slice(0, idx), v.slice(idx + 1));
					if (part) b.formParts.push(part);
				}
				break;
			}
			case "--form-string": {
				// Always literal, `@` included - that is the whole point of the flag.
				const v = value();
				const idx = v.indexOf("=");
				if (idx !== -1) b.formParts.push({ key: v.slice(0, idx), value: v.slice(idx + 1) });
				break;
			}
			case "-G":
			case "--get":
				b.forceGet = true;
				break;
			case "-T":
			case "--upload-file":
				// File contents can't be read from a pasted command, but the flag
				// implies a PUT - record the intent and discard the path.
				value();
				b.uploadFile = true;
				break;
			case "--url":
				b.url = value();
				break;
			default:
				if (CURL_SKIP_WITH_ARG.has(flag)) {
					next(); // consume and ignore its value
				} else if (CURL_NOARG.has(flag)) {
					// no value
				} else if (!flag.startsWith("-")) {
					// Positional argument → URL (first one wins).
					if (!b.url) b.url = arg;
				}
				// Unknown flags are ignored.
				break;
		}
	}

	return resolve(b);
}

// ============================================================================
// wget
// ============================================================================

const WGET_NOARG = new Set([
	"-q",
	"--quiet",
	"--no-check-certificate",
	"--continue",
	"-c",
	"--no-verbose",
	"-nv",
	"--content-disposition",
]);

const WGET_SKIP_WITH_ARG = new Set([
	"-o",
	"--output-file",
	"-O",
	"--output-document",
	"-t",
	"--tries",
	"-T",
	"--timeout",
	"-P",
	"--directory-prefix",
]);

function parseWget(args: string[]): ParsedRequest {
	const b = newBuilder();
	let username: string | undefined;
	let password: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = () => args[++i];

		let flag = arg;
		let inlineValue: string | undefined;
		if (arg.startsWith("--") && arg.includes("=")) {
			const eq = arg.indexOf("=");
			flag = arg.slice(0, eq);
			inlineValue = arg.slice(eq + 1);
		}
		const value = () => inlineValue ?? next();

		switch (flag) {
			case "--method":
				b.method = value().toUpperCase() as HttpMethod;
				break;
			case "--header":
				addHeader(b, value());
				break;
			case "-U":
			case "--user-agent":
				b.headers.push({ key: "User-Agent", value: value() });
				break;
			case "--referer":
				b.headers.push({ key: "Referer", value: value() });
				break;
			case "--body-data":
			case "--post-data": {
				const v = value();
				b.dataParts.push(v);
				break;
			}
			case "--user":
				username = value();
				break;
			case "--password":
				password = value();
				break;
			case "--http-user":
				username = value();
				break;
			case "--http-password":
				password = value();
				break;
			// --post-file sends file contents as the body; can't read it → skip.
			case "--post-file":
				value();
				break;
			default:
				if (WGET_SKIP_WITH_ARG.has(flag)) {
					next();
				} else if (WGET_NOARG.has(flag)) {
					// no value
				} else if (!flag.startsWith("-")) {
					if (!b.url) b.url = arg;
				}
				break;
		}
	}

	if (username !== undefined || password !== undefined) {
		b.basic = { username: username ?? "", password: password ?? "" };
	}

	return resolve(b);
}
