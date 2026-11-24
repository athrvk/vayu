/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief `read_body` (#3704): which stored body a call names, how it is
 *        fetched, and the page of it one result carries - a byte window, the
 *        matches of a search, or a JSON pointer's subtree.
 *
 * Everything here after the fetch reads the record *as masked*: the caller
 * masks the whole record first (`callEngineForRunOutput`), so a secret that
 * straddles a page boundary is already `<redacted>` in both pages, and every
 * offset and size counts the masked bytes.
 */

import type { EngineClient } from "../engine-client.js";
import type { NotFoundDeclaration } from "./contract.js";
import { ID_KINDS, unknownIdText } from "./failure.js";
import { MAX_INLINE_BODY_BYTES, utf8CharStart } from "./inline-body-bounds.js";
import { isRecord, optionalOffset, optionalPositiveInt, str, ToolArgError } from "./kit.js";

/** How many matches one `find` page lists; `matchCount` counts them all. */
export const MAX_FIND_MATCHES = 20;

/** Bytes of context a match carries on each side. */
export const FIND_CONTEXT_BYTES = 80;

/** The longest `find`, so 20 matches with their context stay well under one page. */
export const MAX_FIND_CHARS = 256;

export const BODY_PARTS = ["response", "request"] as const;
type BodyPart = (typeof BODY_PARTS)[number];

/** The stored body a call names. */
export type BodySource =
	| { kind: "result"; runId: string; resultId: number; part: BodyPart; scriptRequest?: number }
	| { kind: "capture"; inboxId: string; captureId: number }
	| { kind: "example"; requestId: string; exampleId: string };

type SourceKind = BodySource["kind"];

/** The arguments that name each source: all of `required`, and `optional` only beside them. */
const SOURCE_ARGS: Readonly<
	Record<SourceKind, { required: readonly string[]; optional: readonly string[] }>
> = {
	result: { required: ["runId", "resultId"], optional: ["part", "scriptRequest"] },
	capture: { required: ["inboxId", "captureId"], optional: [] },
	example: { required: ["requestId", "exampleId"], optional: [] },
};

const SOURCE_KINDS = Object.keys(SOURCE_ARGS) as SourceKind[];

const NAME_A_SOURCE =
	'Name the body to read: "runId" and "resultId" for a run result, "inboxId" and "captureId" for an inbox capture, or "requestId" and "exampleId" for a saved example.';

function namesSource(args: Record<string, unknown>, kind: SourceKind): boolean {
	const { required, optional } = SOURCE_ARGS[kind];
	return [...required, ...optional].some((key) => args[key] !== undefined);
}

/** A required id that is a whole number, such as a result's or a capture's. */
function wholeNumber(args: Record<string, unknown>, key: string): number {
	const value = args[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new ToolArgError(`"${key}" must be a whole number of 0 or more.`);
	}
	return value;
}

function requiredText(args: Record<string, unknown>, key: string): string {
	const value = str(args, key);
	if (value === undefined || value === "")
		throw new ToolArgError(`"${key}" must be a non-empty string.`);
	return value;
}

function bodyPart(args: Record<string, unknown>): BodyPart {
	const part = args.part ?? "response";
	if (part !== "response" && part !== "request") {
		throw new ToolArgError('"part" must be "response" or "request".');
	}
	return part;
}

/**
 * The one source @p args name. Naming none, or arguments of two, is an input
 * error rather than a guess: each source answers a different body.
 */
export function readBodySource(args: Record<string, unknown>): BodySource {
	const named = SOURCE_KINDS.filter((kind) => namesSource(args, kind));
	if (named.length === 0) throw new ToolArgError(NAME_A_SOURCE);
	if (named.length > 1) {
		const given = named.map((kind) => SOURCE_ARGS[kind].required.join(" + ")).join(", ");
		throw new ToolArgError(
			`Arguments of more than one body were given (${given}). ${NAME_A_SOURCE}`
		);
	}
	const [kind] = named;
	const missing = SOURCE_ARGS[kind].required.find((key) => args[key] === undefined);
	if (missing !== undefined) {
		throw new ToolArgError(`"${missing}" is required: ${NAME_A_SOURCE}`);
	}
	if (kind === "capture") {
		return {
			kind,
			inboxId: requiredText(args, "inboxId"),
			captureId: wholeNumber(args, "captureId"),
		};
	}
	if (kind === "example") {
		return {
			kind,
			requestId: requiredText(args, "requestId"),
			exampleId: requiredText(args, "exampleId"),
		};
	}
	const scriptRequest =
		args.scriptRequest === undefined ? undefined : wholeNumber(args, "scriptRequest");
	return {
		kind,
		runId: requiredText(args, "runId"),
		resultId: wholeNumber(args, "resultId"),
		part: bodyPart(args),
		...(scriptRequest === undefined ? {} : { scriptRequest }),
	};
}

/** What a source's ids name, for the engine's 404 on a fetch. */
export const BODY_SOURCE_NOT_FOUND: readonly NotFoundDeclaration[] = [
	{ ...ID_KINDS.run, idArg: "runId" },
	{ ...ID_KINDS.result, idArg: "resultId" },
	{ ...ID_KINDS.inbox, idArg: "inboxId" },
	{ ...ID_KINDS.capture, idArg: "captureId" },
	{ ...ID_KINDS.request, idArg: "requestId" },
];

// --- Fetching -----------------------------------------------------------------

type BodyClient = Pick<EngineClient, "getRunResult" | "getInboxCapture" | "listRequestExamples">;

/**
 * The stored record holding the body @p source names, as the engine stores it:
 * a run's result row with its trace, one inbox capture, one saved example.
 * The engine reads a result and a capture by id, and its 404 for an id it does
 * not hold is mapped by {@link BODY_SOURCE_NOT_FOUND}. An example has no by-id
 * route, so it is found in the list its own tool reads, whose bodies the engine
 * sends whole; an id that list does not hold throws a `not_found`
 * {@link ToolArgError}. Any other engine failure is rethrown as it came.
 */
export async function fetchBodyRecord(
	source: BodySource,
	client: BodyClient,
	signal?: AbortSignal
): Promise<unknown> {
	if (source.kind === "result") {
		return client.getRunResult(source.runId, source.resultId, signal);
	}
	if (source.kind === "example") {
		const rows = await client.listRequestExamples(source.requestId, signal);
		const found = Array.isArray(rows)
			? rows.find((row) => isRecord(row) && row.id === source.exampleId)
			: undefined;
		if (found !== undefined) return found;
		throw new ToolArgError(unknownIdText(ID_KINDS.example, source.exampleId), "not_found");
	}
	return client.getInboxCapture(source.inboxId, source.captureId, signal);
}

// --- The node a body sits on --------------------------------------------------

/** The one exchange node of a run result's trace the call names. */
function traceNode(
	record: unknown,
	source: Extract<BodySource, { kind: "result" }>
): Record<string, unknown> {
	const named = `Result ${source.resultId} of run "${source.runId}"`;
	const trace = isRecord(record) ? record.trace : undefined;
	if (typeof trace === "string") {
		throw new ToolArgError(
			`${named} stored a trace that does not parse, so its bodies cannot be addressed; get_run_report shows it as stored.`
		);
	}
	if (!isRecord(trace)) {
		throw new ToolArgError(
			`${named} stored no trace: a load run keeps its exchanges as samples, which get_run_samples reads.`
		);
	}
	const holder =
		source.scriptRequest === undefined
			? trace
			: scriptRecord(trace, source.scriptRequest, named);
	const node = holder[source.part];
	if (!isRecord(node)) {
		throw new ToolArgError(`${named} has no ${source.part} node there to read.`);
	}
	return node;
}

/** The trace's `pm.sendRequest` record at @p index (#3633). */
function scriptRecord(
	trace: Record<string, unknown>,
	index: number,
	named: string
): Record<string, unknown> {
	const scripts = trace.scripts;
	const records =
		isRecord(scripts) && Array.isArray(scripts.scriptRequests) ? scripts.scriptRequests : [];
	const record: unknown = records[index];
	if (!isRecord(record)) {
		throw new ToolArgError(
			`"scriptRequest" ${index} names no record: ${named} holds ${records.length} pm.sendRequest record(s), numbered from 0.`
		);
	}
	return record;
}

/** The node holding the body @p source names in its (masked) @p record. */
export function bodyNodeOf(source: BodySource, record: unknown): Record<string, unknown> {
	if (source.kind === "result") return traceNode(record, source);
	return isRecord(record) ? record : {};
}

// --- What one call reads ------------------------------------------------------

/** The part of the body one call reads. */
export interface BodyView {
	offset: number;
	length: number;
	find?: string;
	pointer?: string;
}

/** The window, search and pointer arguments, refused before anything is fetched. */
export function readBodyView(args: Record<string, unknown>): BodyView {
	const offset = optionalOffset(args, "offset");
	const length = optionalPositiveInt(args, "length", MAX_INLINE_BODY_BYTES);
	if (length > MAX_INLINE_BODY_BYTES) {
		throw new ToolArgError(
			`"length" must be ${MAX_INLINE_BODY_BYTES} or less; read on from "nextOffset".`
		);
	}
	const find = str(args, "find");
	if (find !== undefined) {
		if (find === "" || find.length > MAX_FIND_CHARS) {
			throw new ToolArgError(`"find" must be 1 to ${MAX_FIND_CHARS} characters.`);
		}
		if (args.length !== undefined) {
			throw new ToolArgError(
				'"find" lists matches and takes no "length"; give "offset" alone.'
			);
		}
	}
	const pointer = str(args, "pointer");
	if (pointer !== undefined && pointer !== "" && !pointer.startsWith("/")) {
		throw new ToolArgError('"pointer" is an RFC 6901 JSON pointer: "" or starting with "/".');
	}
	return {
		offset,
		length,
		...(find === undefined ? {} : { find }),
		...(pointer === undefined ? {} : { pointer }),
	};
}

type BodyEncoding = "utf8" | "base64";

/** A body as the bytes offsets count: a base64 one decoded, a text one as UTF-8. */
export interface BodyContent {
	bytes: Buffer;
	encoding: BodyEncoding;
	/** The store holds only a prefix of what was sent or received. */
	storedTruncated: boolean;
}

export function contentOf(node: Record<string, unknown>): BodyContent {
	const encoding: BodyEncoding = node.bodyEncoding === "base64" ? "base64" : "utf8";
	const body = typeof node.body === "string" ? node.body : "";
	return {
		bytes: Buffer.from(body, encoding),
		encoding,
		storedTruncated: node.bodyTruncated === true || node.bodyCapped === true,
	};
}

/**
 * One page of the body on @p node, as `read_body` answers it: a window of
 * @p view's bytes, or its search's matches, over the whole body or the
 * pointer's subtree. Sizes and offsets count what @p node holds, so masked
 * bytes when the caller masked it.
 */
export function readBodyPage(
	node: Record<string, unknown>,
	view: BodyView
): Record<string, unknown> {
	const stored = contentOf(node);
	const content = view.pointer === undefined ? stored : pointerContent(stored, view.pointer);
	const total = content.bytes.length;
	if (view.offset > total) {
		throw new ToolArgError(
			`"offset" ${view.offset} is past the end: the body is ${total} bytes.`
		);
	}
	const { done, nextOffset, ...page } =
		view.find === undefined
			? windowOf(content, view.offset, view.length)
			: matchesOf(content, view.find, view.offset);
	return {
		...page,
		nextOffset,
		totalBytes: total,
		encoding: content.encoding,
		done,
		...(content.storedTruncated ? { storedTruncated: true } : {}),
	};
}

/** A window or a search, before the body's own facts join it. */
interface Page {
	offset: number;
	nextOffset: number;
	/** Nothing is left past this page: the body's end, or the last match. */
	done: boolean;
	[key: string]: unknown;
}

/** The start of the character after the one starting at @p start. */
function nextCharStart(bytes: Buffer, start: number): number {
	let end = start + 1;
	while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
	return end;
}

/**
 * A text window: both ends on a character boundary, the start stepping back
 * into the character @p offset falls inside, the end back off a split one.
 * A character longer than @p length is returned whole, so a page always moves.
 */
function utf8Window(bytes: Buffer, offset: number, length: number): [number, number] {
	const start = utf8CharStart(bytes, offset);
	if (start + length >= bytes.length) return [start, bytes.length];
	const end = utf8CharStart(bytes, start + length);
	return [start, end > start ? end : nextCharStart(bytes, start)];
}

/**
 * A base64 window: a whole number of 3-byte groups, so its base64 has no
 * padding and the pages read on from 0 concatenate into the body's encoding.
 */
function base64Window(total: number, offset: number, length: number): [number, number] {
	const groups = Math.max(3, length - (length % 3));
	return [offset, Math.min(total, offset + groups)];
}

function windowOf({ bytes, encoding }: BodyContent, offset: number, length: number): Page {
	const [start, end] =
		encoding === "base64"
			? base64Window(bytes.length, offset, length)
			: utf8Window(bytes, offset, length);
	return {
		text: bytes.subarray(start, end).toString(encoding),
		offset: start,
		nextOffset: end,
		done: end >= bytes.length,
	};
}

/** One match's context, {@link FIND_CONTEXT_BYTES} either side, on character boundaries for text. */
function matchAt({ bytes, encoding }: BodyContent, at: number, size: number) {
	let start = Math.max(0, at - FIND_CONTEXT_BYTES);
	let end = Math.min(bytes.length, at + size + FIND_CONTEXT_BYTES);
	if (encoding === "utf8") {
		start = utf8CharStart(bytes, start);
		end = utf8CharStart(bytes, end);
	}
	return {
		offset: at,
		contextOffset: start,
		context: bytes.subarray(start, end).toString(encoding),
	};
}

/**
 * The matches of @p needle (its UTF-8 bytes, in a base64 body's decoded bytes
 * too) at or after @p from: the first {@link MAX_FIND_MATCHES}, and the count
 * over the whole body. Matches do not overlap. `nextOffset` lists on past the
 * last one shown.
 */
function matchesOf(content: BodyContent, needle: string, from: number): Page {
	const pattern = Buffer.from(needle, "utf8");
	const listed: number[] = [];
	let matchCount = 0;
	let more = false;
	for (
		let at = content.bytes.indexOf(pattern);
		at !== -1;
		at = content.bytes.indexOf(pattern, at + pattern.length)
	) {
		matchCount++;
		if (at < from) continue;
		if (listed.length < MAX_FIND_MATCHES) listed.push(at);
		else more = true;
	}
	const last = listed[listed.length - 1];
	return {
		find: needle,
		matchCount,
		matches: listed.map((at) => matchAt(content, at, pattern.length)),
		offset: from,
		nextOffset: more ? last + pattern.length : content.bytes.length,
		done: !more,
	};
}

// --- JSON pointer -------------------------------------------------------------

/** A number as the body wrote it, so a 20-digit id is not re-serialized as a double. */
export class NumberText {
	constructor(readonly source: string) {}
}

/** `JSON.parse`'s reviver with the source text access Node 22 and Electron's V8 pass it. */
type SourceReviver = (key: string, value: unknown, context?: { source?: string }) => unknown;

const keepNumberText: SourceReviver = (_key, value, context) =>
	typeof value === "number" ? new NumberText(context?.source ?? JSON.stringify(value)) : value;

/**
 * A text body's parse, each number a {@link NumberText}; undefined when it is
 * not JSON. The parse is not the wire bytes: a repeated key keeps its last value.
 */
export function parseJsonBody(content: BodyContent): { value: unknown } | undefined {
	try {
		return { value: JSON.parse(content.bytes.toString("utf8"), keepNumberText) };
	} catch {
		return undefined;
	}
}

function parseBody(content: BodyContent): unknown {
	const parsed = parseJsonBody(content);
	if (parsed !== undefined) return parsed.value;
	const prefix = content.storedTruncated ? " (the store holds only a prefix of it)" : "";
	throw new ToolArgError(
		`"pointer" reads a JSON body, and this one does not parse${prefix}; read it by "offset" instead.`
	);
}

/** RFC 6901 section 4: `~1` before `~0`, so `~01` reads as `~1`. */
function unescapeToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** {@link unescapeToken}'s inverse: `~` before `/`, so a key `~1` is written `~01`. */
export function escapeToken(key: string): string {
	return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

function childOf(value: unknown, token: string): { found: boolean; value?: unknown } {
	if (value instanceof NumberText) return { found: false };
	if (Array.isArray(value)) {
		const found = ARRAY_INDEX.test(token) && Number(token) < value.length;
		return found ? { found, value: value[Number(token)] } : { found };
	}
	if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, token)) {
		return { found: true, value: value[token] };
	}
	return { found: false };
}

function resolvePointer(doc: unknown, pointer: string): unknown {
	if (pointer === "") return doc;
	let value = doc;
	let walked = "";
	for (const raw of pointer.slice(1).split("/")) {
		walked += `/${raw}`;
		const child = childOf(value, unescapeToken(raw));
		if (!child.found) {
			throw new ToolArgError(`"pointer" names nothing in the body at "${walked}".`);
		}
		value = child.value;
	}
	return value;
}

/** @p value as compact JSON, each object's keys sorted, each number as the body wrote it. */
export function serializeSorted(value: unknown): string {
	if (value instanceof NumberText) return value.source;
	if (Array.isArray(value)) return `[${value.map(serializeSorted).join(",")}]`;
	if (isRecord(value)) {
		const members = Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${serializeSorted(value[key])}`);
		return `{${members.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** The subtree @p pointer names, as the content a page is read from. */
function pointerContent(content: BodyContent, pointer: string): BodyContent {
	if (content.encoding === "base64") {
		throw new ToolArgError(
			'"pointer" reads a JSON body, and this one is base64 (not text); read it by "offset" instead.'
		);
	}
	const subtree = resolvePointer(parseBody(content), pointer);
	return {
		bytes: Buffer.from(serializeSorted(subtree), "utf8"),
		encoding: "utf8",
		storedTruncated: content.storedTruncated,
	};
}
