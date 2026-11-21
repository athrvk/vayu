/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file log-reader.ts
 * @brief The main-process reader behind the Logs tab (#3635): a listing of
 *        `<data-dir>/logs/`, a bounded page merged across files (backward, or
 *        forward from a jump), and a polling tail.
 *
 * Electron-free, the `log.ts` / `save-file-ipc.ts` shape: `fs`, the logs
 * directory and the timers arrive as arguments, so it is tested against a temp
 * directory. It logs nothing: a tail that logged its own deliveries would feed
 * on them.
 *
 * Trust: a file is opened only by a name from this module's own listing
 * (`LOG_FILE_NAME`, regular files by `lstat`, and the opened handle's identity
 * checked against that listing), never by a path a caller passes. A cursor
 * names files, so every name in one is checked against the pattern and then
 * resolved through the listing.
 *
 * Time comes from each record's `ts`, never a file name: the engine stamps its
 * name in local time and the app in UTC, so names do not sort across sources.
 * Within one file records are in time order (one writer per file), which both
 * merges and the `around` bisection rely on.
 */

import path from "path";
import type { BigIntStats } from "fs";
import { LEVEL_ORDER, type LogLevel } from "./log.js";

/** The most records one `readLogs` call answers. */
export const LOG_READ_LIMIT_MAX = 1000;
/** Bytes one `readLogs` call (or one tail poll) reads before it stops and pages. */
export const LOG_SCAN_BUDGET_BYTES = 8 * 1024 * 1024;
export const LOG_TAIL_POLL_MS = 500;
/**
 * The most records one tail batch carries. One batch per 500 ms poll keeps the
 * tail under the issue's bound of 500 records per 250 ms.
 */
export const LOG_TAIL_BATCH_MAX = 500;
/** Where a line that is not a record has its `raw` text cut. */
export const UNPARSED_RAW_MAX_BYTES = 8 * 1024;
/** A record whose line is longer than this has its largest fields cut. */
export const RECORD_MAX_BYTES = 256 * 1024;
/**
 * A line longer than this is not parsed at all: it comes back unparsed, its
 * first `UNPARSED_RAW_MAX_BYTES`, and only those bytes are held while the rest
 * of it is read past.
 */
const LINE_MAX_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
/** What a cut field keeps of its text before the marker. */
const CUT_FIELD_HEAD_BYTES = 1024;
/** The marker `log-ipc.ts` appends to the text it cuts, so a cut reads the same on both. */
const TRUNCATION_MARKER = "...[truncated]";

/**
 * Every file the loggers write: `<prefix>_<YYYYMMDD>_<HHMMSS>.log`, and its one
 * rotation generation `.1` (`engine/src/utils/logger.cpp`, `log.ts`). Anchored,
 * so no name it accepts holds a separator or `..`.
 */
const LOG_FILE_NAME = /^(engine|app|cli|mcp)_\d{8}_\d{6}\.log(\.1)?$/;
/** `ts` as `docs/engine/log-record.schema.json` pins it: fixed width, so it sorts as text. */
const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A field name, as the schema's `propertyNames` allows one. */
const FIELD_NAME = /^[a-z][a-zA-Z0-9_]*$/;
/** Sorts after every `ts`. */
const NEWEST_KEY = "￿";
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export type LogFileSource = "engine" | "app" | "cli" | "mcp";

export interface LogFileInfo {
	name: string;
	source: LogFileSource;
	size: number;
	mtimeMs: number;
}

/**
 * The key a record carries its own line under, so Copy line and Export write
 * what the file holds and not a re-serialisation (`1.0` reads back as `1`). It
 * starts with `$`, which `docs/engine/log-record.schema.json`'s `propertyNames`
 * refuses, so no field of a schema-valid record shares it and a `key:value`
 * search term (`FIELD_NAME`) cannot name it. A line that does carry the key has
 * it overwritten, and loses nothing: the line is the value. Mirrored by
 * `RAW_LINE_KEY` in `src/modules/logs/log-entry.ts`, and held equal to it by
 * `log-raw-line.conformance.test.ts`.
 */
export const RAW_LINE_KEY = "$raw";

/**
 * The key every line the reader delivers carries its place in its file under,
 * so a page can be continued from any line the renderer still holds (#3652).
 * `$`-prefixed for the reason `RAW_LINE_KEY` is, and mirrored and held equal
 * the same way (`log-raw-line.conformance.test.ts`). An unparsed line carries
 * it under the same key.
 */
export const POSITION_KEY = "$pos";

/**
 * Where a delivered line sits. `name` and `id` are the file's, as a cursor
 * entry names it (`LogCursorFile`); `start` is the offset of the line's first
 * byte, and `end` the offset just past its newline, or the file's end for a
 * last line that has none.
 */
export interface LogLinePosition {
	name: string;
	id: string;
	start: number;
	end: number;
}

/** One line of a log file that is a record (`docs/engine/log-record.schema.json`). */
export interface LogFileRecord {
	ts: string;
	level: LogLevel;
	src: string;
	cat: string;
	msg: string;
	pid: number;
	tid?: string;
	/** The line as the file holds it, cut at `RECORD_MAX_BYTES`. Absent on a record built outside the reader. */
	[RAW_LINE_KEY]?: string;
	/** Absent on a record built outside the reader. */
	[POSITION_KEY]?: LogLinePosition;
	[field: string]: unknown;
}

/** A line that is not JSON, or is JSON without the record's required keys. */
export interface UnparsedLogLine {
	unparsed: true;
	raw: string;
	/** Absent on a line built outside the reader. */
	[POSITION_KEY]?: LogLinePosition;
}

export type LogEntry = LogFileRecord | UnparsedLogLine;

/** A record always carries a string `ts`; a field named `unparsed` cannot pass for this. */
export function isUnparsedLine(entry: LogEntry): entry is UnparsedLogLine {
	return entry.unparsed === true && !("ts" in entry);
}

/** `field:value`. `exact` (the value was quoted) compares whole and case-sensitive. */
export interface LogFieldTerm {
	field: string;
	value: string;
	exact: boolean;
}

/**
 * What a read or a tail keeps. An absent or empty set does not constrain.
 * A line that is not a record has no level, source, category or fields, so it
 * passes only a filter that constrains none of them, and its free text is
 * matched against the raw line.
 */
export interface LogFilter {
	minLevel?: LogLevel;
	sources?: readonly string[];
	categories?: readonly string[];
	text?: string;
	terms?: readonly LogFieldTerm[];
}

/**
 * Where a read stopped, per file. Backward, everything from `offset` to the
 * end of the file as it was first read has been consumed; forward, everything
 * before `offset`. `id` is the file's device and inode, so a file renamed to
 * `.1` by a rotation between two pages is still found; it is empty where the
 * filesystem reports no inode, and the name is used instead.
 */
export interface LogCursorFile {
	name: string;
	id: string;
	offset: number;
}

export interface LogCursor {
	files: LogCursorFile[];
}

/** At most one of `before`, `around` and `after`; none reads the newest records. */
export interface ReadLogsOptions {
	/** Continue older from a backward or `around` read's `cursor`; files not in it are newer and left to the tail. */
	before?: LogCursor;
	/** Jump to time: answer the newest records at or before this `ts`. */
	around?: string;
	/**
	 * Continue newer from an `after` read's `cursor` or an `around` read's
	 * `newer`: answer the oldest records past it. Files not in it appeared since
	 * (a rotation's fresh file, a restarted engine) and are read from their start.
	 */
	after?: LogCursor;
	filter: LogFilter;
	/** Clamped to `LOG_READ_LIMIT_MAX`. */
	limit: number;
}

/** `cursor`, `more` and `scannedTo` point the way the read went: older, or newer for `after`. */
export interface ReadLogsResult {
	/** Oldest first. */
	records: LogEntry[];
	/** Where the next page in the same direction starts. */
	cursor: LogCursor;
	/** Data remains in that direction that this call did not search or did not return. */
	more: boolean;
	/** The `ts` of the furthest record this call examined, matching or not. */
	scannedTo: string | null;
	/** An `around` read's: where the records later than the time start, for an `after` read. */
	newer?: LogCursor;
}

/** The handle `fs.promises.open` answers, as far as this module uses it. */
export interface LogFileHandle {
	read(
		buffer: Buffer,
		offset: number,
		length: number,
		position: number
	): Promise<{ bytesRead: number }>;
	stat(options: { bigint: true }): Promise<BigIntStats>;
	close(): Promise<void>;
}

/** `fs.promises`, as far as this module uses it. */
export interface LogReaderFs {
	readdir(dir: string): Promise<string[]>;
	lstat(file: string, options: { bigint: true }): Promise<BigIntStats>;
	open(file: string, flags: "r"): Promise<LogFileHandle>;
}

export interface LogReaderDeps {
	fs: LogReaderFs;
	logsDir: string;
	/** Defaults to `LOG_SCAN_BUDGET_BYTES`; a test passes a small one. */
	scanBudgetBytes?: number;
	/** The read size; a test passes small ones to put a chunk boundary on every byte. */
	chunkBytes?: number;
}

export interface LogTailTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface LogTailDeps extends LogReaderDeps {
	timers: LogTailTimers;
}

export interface LogBatch {
	/** Oldest first. */
	records: LogEntry[];
	/** Matching records left out of this batch because it was over `LOG_TAIL_BATCH_MAX`. */
	dropped: number;
}

export interface LogTailOptions {
	filter: LogFilter;
	onBatch(batch: LogBatch): void;
}

export interface LogTail {
	stop(): void;
}

// ---------------------------------------------------------------------------
// Listing

interface ScannedFile extends LogFileInfo {
	id: string;
	rotated: boolean;
}

export function isLogFileName(name: string): boolean {
	return LOG_FILE_NAME.test(name);
}

function isNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function identityOf(stats: BigIntStats): string {
	return stats.ino === 0n ? "" : `${stats.dev}:${stats.ino}`;
}

async function scanLogFiles(deps: LogReaderDeps): Promise<ScannedFile[]> {
	let names: string[];
	try {
		names = await deps.fs.readdir(deps.logsDir);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
	const scanned = await Promise.all(
		names.filter(isLogFileName).map((name) => scanOne(deps, name))
	);
	return scanned
		.filter((file): file is ScannedFile => file !== null)
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function scanOne(deps: LogReaderDeps, name: string): Promise<ScannedFile | null> {
	let stats: BigIntStats;
	try {
		stats = await deps.fs.lstat(path.join(deps.logsDir, name), { bigint: true });
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
	// `lstat`, so a symlink is itself and not a regular file: refused.
	if (!stats.isFile()) return null;
	return {
		name,
		source: name.slice(0, name.indexOf("_")) as LogFileSource,
		size: Number(stats.size),
		mtimeMs: Number(stats.mtimeMs),
		id: identityOf(stats),
		rotated: name.endsWith(".1"),
	};
}

/** The log files in the logs directory, regular files only. Empty when there is no directory yet. */
export async function listLogFiles(deps: LogReaderDeps): Promise<LogFileInfo[]> {
	const files = await scanLogFiles(deps);
	return files.map(({ name, source, size, mtimeMs }) => ({ name, source, size, mtimeMs }));
}

/**
 * Open a listed file and confirm the handle is the file the listing saw: a
 * name swapped for a symlink or another file between the two is refused.
 * `null` when it is gone or no longer that file.
 */
async function openListed(deps: LogReaderDeps, file: ScannedFile): Promise<LogFileHandle | null> {
	let handle: LogFileHandle;
	try {
		handle = await deps.fs.open(path.join(deps.logsDir, file.name), "r");
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
	try {
		const stats = await handle.stat({ bigint: true });
		if (stats.isFile() && (file.id === "" || identityOf(stats) === file.id)) return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
	await handle.close();
	return null;
}

// ---------------------------------------------------------------------------
// Lines and entries

interface ScanCounter {
	bytes: number;
}

/** A complete line, newline excluded. `bytes` is the whole line unless `oversize`. */
interface RawLine {
	bytes: Buffer;
	length: number;
	oversize: boolean;
}

interface PositionedLine extends RawLine {
	/** Byte offset of the line's first byte in its file. */
	start: number;
	/** Byte offset just past the line's newline, or the end of what was read when none follows. */
	end: number;
}

async function readAt(
	handle: LogFileHandle,
	position: number,
	length: number,
	counter: ScanCounter
): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	counter.bytes += filled;
	return buffer.subarray(0, filled);
}

/** @p bytes cut to at most @p max without splitting a UTF-8 sequence. */
function utf8Prefix(bytes: Buffer, max: number): Buffer {
	if (bytes.length <= max) return bytes;
	let end = max;
	while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end);
}

/**
 * The line made of @p parts once its length is @p length: whole, or past
 * `LINE_MAX_BYTES` only its first bytes. The parts are in file order.
 */
function joinLine(parts: Buffer[], length: number): RawLine {
	const bytes = Buffer.concat(parts);
	const oversize = length > LINE_MAX_BYTES;
	return {
		bytes: oversize ? bytes.subarray(0, UNPARSED_RAW_MAX_BYTES) : bytes,
		length,
		oversize,
	};
}

/** Past `LINE_MAX_BYTES` a line is held as its first bytes only, so a giant line costs no memory. */
function compactParts(parts: Buffer[], length: number): Buffer[] {
	return length > LINE_MAX_BYTES
		? [Buffer.concat(parts).subarray(0, UNPARSED_RAW_MAX_BYTES)]
		: parts;
}

function isLogRecord(value: unknown): value is LogFileRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.ts === "string" &&
		TS_PATTERN.test(record.ts) &&
		typeof record.level === "string" &&
		Object.prototype.hasOwnProperty.call(LEVEL_ORDER, record.level) &&
		typeof record.src === "string" &&
		typeof record.cat === "string" &&
		typeof record.msg === "string" &&
		Number.isInteger(record.pid)
	);
}

function unparsed(bytes: Buffer): UnparsedLogLine {
	return { unparsed: true, raw: utf8Prefix(bytes, UNPARSED_RAW_MAX_BYTES).toString("utf8") };
}

/** Keys a cut never touches: small, and what the table and the merge are keyed on. */
const UNCUT_KEYS = new Set(["ts", "level", "src", "cat", "pid"]);

function serialisedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "");
}

/**
 * A record over `RECORD_MAX_BYTES` with its largest fields, largest first,
 * replaced by the head of their text and the truncation marker until it fits.
 */
function cutLargestFields(record: LogFileRecord, lineBytes: number): LogFileRecord {
	const sizes = Object.keys(record)
		.filter((key) => !UNCUT_KEYS.has(key))
		.map((key) => ({ key, bytes: serialisedBytes(record[key]) }))
		.sort((a, b) => b.bytes - a.bytes);
	const result: LogFileRecord = { ...record };
	let excess = lineBytes - RECORD_MAX_BYTES;
	for (const { key, bytes } of sizes) {
		if (excess <= 0) break;
		const value = record[key];
		const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
		const cut =
			utf8Prefix(Buffer.from(text), CUT_FIELD_HEAD_BYTES).toString("utf8") +
			TRUNCATION_MARKER;
		result[key] = cut;
		excess -= bytes - serialisedBytes(cut);
	}
	return result;
}

/** `null` for a blank line, which is neither a record nor worth showing. */
function decodeLine(line: RawLine): LogEntry | null {
	const bytes =
		line.bytes.length > 0 && line.bytes.readUInt8(line.bytes.length - 1) === CARRIAGE_RETURN
			? line.bytes.subarray(0, -1)
			: line.bytes;
	if (bytes.length === 0) return null;
	if (line.oversize) return unparsed(bytes);
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		return unparsed(bytes);
	}
	if (!isLogRecord(value)) return unparsed(bytes);
	const record = line.length > RECORD_MAX_BYTES ? cutLargestFields(value, line.length) : value;
	// The bounded line, never the whole text: a record the parse ceiling lets
	// through can be 16 MiB, and a copy of it would double what the IPC carries.
	record[RAW_LINE_KEY] = utf8Prefix(bytes, RECORD_MAX_BYTES).toString("utf8");
	return record;
}

/** `decodeLine`, with the line's place in @p file attached under `POSITION_KEY`. */
function decodeInFile(line: PositionedLine, file: ScannedFile): LogEntry | null {
	const entry = decodeLine(line);
	if (entry) {
		entry[POSITION_KEY] = { name: file.name, id: file.id, start: line.start, end: line.end };
	}
	return entry;
}

// ---------------------------------------------------------------------------
// Filter

/**
 * Keys free text does not search: the table shows them in columns of their own,
 * the raw line repeats every field, so it would match on key names, and the
 * position names the file.
 */
const TEXT_EXCLUDED_KEYS = new Set([
	"ts",
	"level",
	"src",
	"cat",
	"pid",
	"tid",
	RAW_LINE_KEY,
	POSITION_KEY,
]);

function containsText(value: unknown, needle: string): boolean {
	if (typeof value === "string") return value.toLowerCase().includes(needle);
	if (Array.isArray(value)) return value.some((item) => containsText(item, needle));
	if (value !== null && typeof value === "object") {
		return Object.values(value).some((item) => containsText(item, needle));
	}
	return false;
}

function recordHasText(record: LogFileRecord, needle: string): boolean {
	return Object.entries(record).some(
		([key, value]) => !TEXT_EXCLUDED_KEYS.has(key) && containsText(value, needle)
	);
}

/** A field's value as a term compares it: a number by its string form. */
function fieldText(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value) ?? "";
}

function nonEmptySet(values: readonly string[] | undefined): ReadonlySet<string> | null {
	return values && values.length > 0 ? new Set(values) : null;
}

interface CompiledTerm extends LogFieldTerm {
	/** The value folded for a substring match. */
	folded: string;
	/** The token as typed, folded, for a term that may also match as text; `null` when exact. */
	typed: string | null;
}

/** A term matches by its field, or (unless exact) by the text it was typed as. */
function matchesTerm(entry: LogFileRecord, term: CompiledTerm): boolean {
	if (term.typed !== null && recordHasText(entry, term.typed)) return true;
	if (!Object.prototype.hasOwnProperty.call(entry, term.field)) return false;
	const value = fieldText(entry[term.field]);
	return term.exact ? value === term.value : value.toLowerCase().includes(term.folded);
}

/** The one evaluator: a read and a tail with the same filter keep the same lines. */
export function compileLogFilter(filter: LogFilter): (entry: LogEntry) => boolean {
	const floor = LEVEL_ORDER[filter.minLevel ?? "debug"];
	const sources = nonEmptySet(filter.sources);
	const categories = nonEmptySet(filter.categories);
	const trimmed = filter.text?.trim().toLowerCase() ?? "";
	const text = trimmed === "" ? null : trimmed;
	const terms = (filter.terms ?? []).map((term) => ({
		...term,
		folded: term.value.toLowerCase(),
		// A bare `host:port` parses as a term (`localhost` = `47813`), so it also
		// matches the text as typed (#3678). A quoted term is an explicit field
		// match and has no such reading.
		typed: term.exact ? null : `${term.field}:${term.value}`.toLowerCase(),
	}));
	const structured = floor > 0 || sources !== null || categories !== null || terms.length > 0;

	return (entry) => {
		if (isUnparsedLine(entry)) {
			return !structured && (text === null || entry.raw.toLowerCase().includes(text));
		}
		if (LEVEL_ORDER[entry.level] < floor) return false;
		if (sources && !sources.has(entry.src)) return false;
		if (categories && !categories.has(entry.cat)) return false;
		if (text !== null && !recordHasText(entry, text)) return false;
		return terms.every((term) => matchesTerm(entry, term));
	};
}

/** A quoted run (with any prefix glued to it, `cat:"oauth"`), or a bare token. */
const SEARCH_TOKEN = /([^\s"]*)"([^"]*)"|(\S+)/g;

/**
 * A search box's text as free text plus `field:value` terms. `field:"v w"`
 * is an exact term, `field:v` a substring one; everything else, quoted
 * phrases included, joins into the free text. A value starting `//` is a URL
 * (`http://host`), not a term.
 */
export function parseSearchInput(input: string): { text: string; terms: LogFieldTerm[] } {
	const words: string[] = [];
	const terms: LogFieldTerm[] = [];
	for (const [token, prefix, quoted, bare] of input.matchAll(SEARCH_TOKEN)) {
		if (bare !== undefined) {
			const colon = bare.indexOf(":");
			const field = bare.slice(0, colon);
			const value = bare.slice(colon + 1);
			if (colon > 0 && FIELD_NAME.test(field) && value !== "" && !value.startsWith("//")) {
				terms.push({ field, value, exact: false });
			} else {
				words.push(bare);
			}
			continue;
		}
		const field = prefix.endsWith(":") ? prefix.slice(0, -1) : "";
		if (FIELD_NAME.test(field)) {
			terms.push({ field, value: quoted, exact: true });
		} else {
			words.push(prefix === "" ? quoted : token);
		}
	}
	return { text: words.join(" "), terms };
}

// ---------------------------------------------------------------------------
// Backward read

/** The index of the last newline in @p chunk before @p end, or -1. */
function lastNewlineBefore(chunk: Buffer, end: number): number {
	return end > 0 ? chunk.lastIndexOf(NEWLINE, end - 1) : -1;
}

/**
 * A file's complete lines, newest first, read backwards in chunks. The bytes
 * before a chunk's first newline belong to a line that starts in an earlier
 * chunk: they are carried, as raw bytes, until that start is read, so a line
 * (and a multi-byte character) split by a chunk boundary is decoded whole.
 */
class BackwardLines {
	private pos: number;
	/** The front of the line that ends in the chunks already read, in file order. */
	private carry: Buffer[] = [];
	private carryBytes = 0;
	/** The current chunk's complete lines, oldest first, so `pop` answers the newest. */
	private pending: PositionedLine[] = [];

	constructor(
		private readonly handle: LogFileHandle,
		private readonly end: number,
		private readonly chunkBytes: number,
		private readonly counter: ScanCounter
	) {
		this.pos = end;
	}

	hasMore(): boolean {
		return this.pending.length > 0 || this.carryBytes > 0 || this.pos > 0;
	}

	async next(): Promise<PositionedLine | null> {
		while (this.pending.length === 0) {
			if (this.pos === 0) return this.takeFirstLine();
			await this.readChunk();
		}
		return this.pending.pop() ?? null;
	}

	private async readChunk(): Promise<void> {
		const start = Math.max(0, this.pos - this.chunkBytes);
		const chunk = await readAt(this.handle, start, this.pos - start, this.counter);
		if (chunk.length !== this.pos - start) {
			throw new Error("A log file shrank while it was read");
		}
		this.pos = start;
		const newestFirst: PositionedLine[] = [];
		let end = chunk.length;
		let newline = lastNewlineBefore(chunk, end);
		if (newline !== -1) {
			newestFirst.push(
				this.completeCarry(chunk.subarray(newline + 1, end), start + newline + 1)
			);
			end = newline;
			newline = lastNewlineBefore(chunk, end);
		}
		while (newline !== -1) {
			const bytes = chunk.subarray(newline + 1, end);
			newestFirst.push(
				this.positioned(
					{ bytes, length: bytes.length, oversize: false },
					start + newline + 1
				)
			);
			end = newline;
			newline = lastNewlineBefore(chunk, end);
		}
		this.prependCarry(chunk.subarray(0, end));
		this.pending = newestFirst.reverse();
	}

	/** At the start of the file, the carry is the file's first line. */
	private takeFirstLine(): PositionedLine | null {
		return this.carryBytes > 0 ? this.completeCarry(Buffer.alloc(0), 0) : null;
	}

	private prependCarry(front: Buffer): void {
		if (front.length === 0) return;
		this.carryBytes += front.length;
		this.carry = compactParts([front, ...this.carry], this.carryBytes);
	}

	private completeCarry(front: Buffer, start: number): PositionedLine {
		const line = joinLine([front, ...this.carry], front.length + this.carryBytes);
		this.carry = [];
		this.carryBytes = 0;
		return this.positioned(line, start);
	}

	/**
	 * A line ends just past its newline, unless it runs up to the offset this
	 * read started from: no newline came before that offset, so it is the file's
	 * end and the line ends there.
	 */
	private positioned(line: RawLine, start: number): PositionedLine {
		return { ...line, start, end: Math.min(start + line.length + 1, this.end) };
	}
}

/** The offset just past the file's last newline: where its complete lines end. */
async function completeLinesEnd(
	handle: LogFileHandle,
	size: number,
	chunkBytes: number,
	counter: ScanCounter
): Promise<number> {
	for (let pos = size; pos > 0;) {
		const start = Math.max(0, pos - chunkBytes);
		const chunk = await readAt(handle, start, pos - start, counter);
		const newline = chunk.lastIndexOf(NEWLINE);
		if (newline !== -1) return start + newline + 1;
		pos = start;
	}
	return 0;
}

/** The line starting at @p start, and the offset of the line after it. */
async function readLineForward(
	handle: LogFileHandle,
	start: number,
	end: number,
	chunkBytes: number,
	counter: ScanCounter
): Promise<{ line: RawLine; next: number }> {
	let parts: Buffer[] = [];
	let length = 0;
	for (let pos = start; pos < end;) {
		const chunk = await readAt(handle, pos, Math.min(chunkBytes, end - pos), counter);
		if (chunk.length === 0) break;
		const newline = chunk.indexOf(NEWLINE);
		const piece = newline === -1 ? chunk : chunk.subarray(0, newline);
		length += piece.length;
		parts = compactParts([...parts, piece], length);
		if (newline !== -1) return { line: joinLine(parts, length), next: pos + newline + 1 };
		pos += chunk.length;
	}
	return { line: joinLine(parts, length), next: end };
}

/**
 * The offset of the first line that holds a record with `ts` later than
 * @p around, or @p end: the file cut for jump to time. A bisection on byte
 * offset, probing the first record at or after each midpoint.
 */
async function offsetAfter(
	handle: LogFileHandle,
	end: number,
	around: string,
	chunkBytes: number,
	counter: ScanCounter
): Promise<number> {
	const lineStartAtOrAfter = async (offset: number): Promise<number> =>
		offset === 0
			? 0
			: (await readLineForward(handle, offset - 1, end, chunkBytes, counter)).next;

	const firstTsAtOrAfter = async (offset: number): Promise<string | null> => {
		for (let start = await lineStartAtOrAfter(offset); start < end;) {
			const { line, next } = await readLineForward(handle, start, end, chunkBytes, counter);
			const entry = decodeLine(line);
			if (entry && !isUnparsedLine(entry)) return entry.ts;
			start = next;
		}
		return null;
	};

	let low = 0;
	let high = end;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		const ts = await firstTsAtOrAfter(mid);
		if (ts === null || ts > around) high = mid;
		else low = mid + 1;
	}
	return lineStartAtOrAfter(low);
}

interface BackwardStream {
	file: ScannedFile;
	lines: BackwardLines;
	/** Everything from here to the stream's end has been consumed. */
	offset: number;
	head: { line: PositionedLine; entry: LogEntry; key: string } | null;
	/** The `ts` of the newer neighbour, the merge key of a line that has none. */
	lastKey: string;
}

async function loadHead(stream: BackwardStream): Promise<void> {
	for (;;) {
		const line = await stream.lines.next();
		if (line === null) {
			stream.head = null;
			return;
		}
		const entry = decodeInFile(line, stream.file);
		if (entry === null) {
			stream.offset = line.start;
			continue;
		}
		stream.head = { line, entry, key: isUnparsedLine(entry) ? stream.lastKey : entry.ts };
		return;
	}
}

function newestHead(streams: BackwardStream[]): BackwardStream | null {
	let newest: BackwardStream | null = null;
	for (const stream of streams) {
		if (stream.head && (newest === null || stream.head.key > (newest.head?.key ?? ""))) {
			newest = stream;
		}
	}
	return newest;
}

/**
 * The newest source file of each prefix, the one a live writer may still be
 * appending to: its last line, if it has no newline yet, is held back.
 */
function liveFiles(files: ScannedFile[]): Set<string> {
	const newest = new Map<LogFileSource, string>();
	for (const file of files) {
		if (file.rotated) continue;
		const current = newest.get(file.source);
		if (current === undefined || file.name > current) newest.set(file.source, file.name);
	}
	return new Set(newest.values());
}

function checkCursor(cursor: LogCursor): void {
	for (const entry of cursor.files) {
		if (!isLogFileName(entry.name)) {
			throw new Error(`Not a log file name: ${JSON.stringify(entry.name)}`);
		}
		if (!Number.isSafeInteger(entry.offset) || entry.offset < 0) {
			throw new Error(`A log cursor offset must be a whole number of bytes: ${entry.offset}`);
		}
	}
}

/** The listed file a cursor entry means: by identity, or by name where there is none. */
function resolveCursorFile(files: ScannedFile[], entry: LogCursorFile): ScannedFile | undefined {
	if (entry.id !== "") return files.find((file) => file.id === entry.id);
	return files.find((file) => file.name === entry.name);
}

function checkReadOptions(options: ReadLogsOptions): number {
	if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
		throw new Error(`A log read limit must be a positive whole number: ${options.limit}`);
	}
	const anchors = [options.before, options.around, options.after].filter((v) => v !== undefined);
	if (anchors.length > 1) {
		throw new Error("A log read takes one of `before`, `around` or `after`, not more");
	}
	if (options.around !== undefined && !TS_PATTERN.test(options.around)) {
		throw new Error(`Not a log timestamp: ${JSON.stringify(options.around)}`);
	}
	if (options.before) checkCursor(options.before);
	if (options.after) checkCursor(options.after);
	return Math.min(options.limit, LOG_READ_LIMIT_MAX);
}

/** What one `readLogs` call reads with, shared by both directions. */
interface ReadContext {
	deps: LogReaderDeps;
	files: ScannedFile[];
	matches: (entry: LogEntry) => boolean;
	limit: number;
	budget: number;
	chunkBytes: number;
	counter: ScanCounter;
	/** Every handle the call opened, closed when it answers. */
	handles: LogFileHandle[];
}

async function openForRead(context: ReadContext, file: ScannedFile): Promise<LogFileHandle | null> {
	const handle = await openListed(context.deps, file);
	if (handle) context.handles.push(handle);
	return handle;
}

function cursorEntry(file: ScannedFile, offset: number): LogCursorFile {
	return { name: file.name, id: file.id, offset };
}

/** Each file to read and the offset its backward read starts from. */
function filesToRead(
	files: ScannedFile[],
	cursor: LogCursor | undefined
): { file: ScannedFile; end: number | null }[] {
	if (!cursor) return files.map((file) => ({ file, end: null }));
	const selected: { file: ScannedFile; end: number | null }[] = [];
	for (const entry of cursor.files) {
		const file = resolveCursorFile(files, entry);
		if (!file || selected.some((chosen) => chosen.file === file)) continue;
		selected.push({ file, end: Math.min(entry.offset, file.size) });
	}
	return selected;
}

async function streamEnd(
	handle: LogFileHandle,
	file: ScannedFile,
	options: ReadLogsOptions,
	live: boolean,
	chunkBytes: number,
	counter: ScanCounter
): Promise<number> {
	const end = live ? await completeLinesEnd(handle, file.size, chunkBytes, counter) : file.size;
	if (options.around === undefined) return end;
	return offsetAfter(handle, end, options.around, chunkBytes, counter);
}

/**
 * The `limit` records that match the filter nearest the cursor, merged across
 * every log file by `ts`: the newest older than a `before` or `around` cursor,
 * or the oldest newer than an `after` one. Reads in chunks and stops once the
 * call has read its scan budget, so a search through a long history is paged;
 * the returned cursor continues exactly where it stopped. A call always
 * consumes at least one line when any remain, so a page that found nothing
 * still moves `scannedTo` on.
 */
export async function readLogs(
	deps: LogReaderDeps,
	options: ReadLogsOptions
): Promise<ReadLogsResult> {
	const context: ReadContext = {
		deps,
		limit: checkReadOptions(options),
		matches: compileLogFilter(options.filter),
		chunkBytes: deps.chunkBytes ?? CHUNK_BYTES,
		budget: deps.scanBudgetBytes ?? LOG_SCAN_BUDGET_BYTES,
		counter: { bytes: 0 },
		files: await scanLogFiles(deps),
		handles: [],
	};
	try {
		return options.after
			? await readForward(context, options.after)
			: await readBackward(context, options);
	} finally {
		await Promise.all(context.handles.map((handle) => handle.close()));
	}
}

/**
 * Open a listed file for a backward read, following it to its new name when a
 * rotation renamed it between the listing and the open (#3652). The forward
 * read can leave such a file in its cursor for the next page, since it knows
 * the offset that page starts from; a backward read without a cursor measures
 * where the file's lines end on the file itself, and an `around` read where
 * the time cuts it, so it reads the renamed file now. `null` when the file is
 * gone, or has no identity to follow it by.
 */
async function openFollowingRename(
	context: ReadContext,
	file: ScannedFile
): Promise<{ file: ScannedFile; handle: LogFileHandle } | null> {
	const handle = await openForRead(context, file);
	if (handle) return { file, handle };
	if (file.id === "") return null;
	const relisted = await scanLogFiles(context.deps);
	const renamed = relisted.find((other) => other.id === file.id && other.name !== file.name);
	if (!renamed) return null;
	const reopened = await openForRead(context, renamed);
	return reopened ? { file: renamed, handle: reopened } : null;
}

async function readBackward(
	context: ReadContext,
	options: ReadLogsOptions
): Promise<ReadLogsResult> {
	const { files, chunkBytes, counter } = context;
	const live = options.before ? new Set<string>() : liveFiles(files);
	const streams: BackwardStream[] = [];
	/** Where each file was cut: for `around`, where the records later than the time start. */
	const cut: LogCursorFile[] = [];
	for (const { file, end: cursorEnd } of filesToRead(files, options.before)) {
		const opened = await openFollowingRename(context, file);
		if (!opened) continue;
		// Measured as the listing saw the file, under the name it was listed by:
		// a line appended after the listing, before a rotation, is the tail's.
		const end =
			cursorEnd ??
			(await streamEnd(
				opened.handle,
				file,
				options,
				live.has(file.name),
				chunkBytes,
				counter
			));
		cut.push(cursorEntry(opened.file, end));
		const lines = new BackwardLines(opened.handle, end, chunkBytes, counter);
		const stream: BackwardStream = {
			file: opened.file,
			lines,
			offset: end,
			head: null,
			lastKey: NEWEST_KEY,
		};
		await loadHead(stream);
		streams.push(stream);
	}
	const result = await mergeNewestFirst(streams, context);
	return options.around === undefined ? result : { ...result, newer: { files: cut } };
}

async function mergeNewestFirst(
	streams: BackwardStream[],
	{ matches, limit, budget, counter }: ReadContext
): Promise<ReadLogsResult> {
	const newestFirst: LogEntry[] = [];
	let scannedTo: string | null = null;
	for (let stream = newestHead(streams); stream?.head; stream = newestHead(streams)) {
		const { line, entry, key } = stream.head;
		stream.head = null;
		stream.offset = line.start;
		stream.lastKey = key;
		if (!isUnparsedLine(entry)) scannedTo = entry.ts;
		if (matches(entry)) newestFirst.push(entry);
		if (newestFirst.length >= limit || counter.bytes >= budget) break;
		await loadHead(stream);
	}
	return {
		records: newestFirst.reverse(),
		cursor: {
			files: streams
				.filter((stream) => stream.offset > 0)
				.map((stream) => cursorEntry(stream.file, stream.offset)),
		},
		more: streams.some((stream) => stream.head !== null || stream.lines.hasMore()),
		scannedTo,
	};
}

// ---------------------------------------------------------------------------
// Forward read

/**
 * Splits bytes read forward into complete lines. The bytes after the last
 * newline are a line still being written: they wait, as raw bytes, for the
 * newline, so a record is never delivered half-written. Shared by the tail and
 * the forward read, which push the file's bytes in order from @p start.
 */
class ForwardLines {
	private carry: Buffer[] = [];
	private carryBytes = 0;
	/** Where the held line starts in the file. */
	private lineStart: number;
	/** Just past the last byte pushed. */
	private pos: number;

	constructor(start: number) {
		this.lineStart = start;
		this.pos = start;
	}

	push(chunk: Buffer): PositionedLine[] {
		const lines: PositionedLine[] = [];
		let from = 0;
		for (
			let newline = chunk.indexOf(NEWLINE);
			newline !== -1;
			newline = chunk.indexOf(NEWLINE, from)
		) {
			const back = chunk.subarray(from, newline);
			const line = joinLine([...this.carry, back], this.carryBytes + back.length);
			const end = this.pos + newline + 1;
			lines.push({ ...line, start: this.lineStart, end });
			this.lineStart = end;
			this.carry = [];
			this.carryBytes = 0;
			from = newline + 1;
		}
		this.pos += chunk.length;
		const rest = chunk.subarray(from);
		if (rest.length > 0) {
			this.carryBytes += rest.length;
			this.carry = compactParts([...this.carry, rest], this.carryBytes);
		}
		return lines;
	}

	holds(): boolean {
		return this.carryBytes > 0;
	}

	/** The held bytes as a line: a file no writer appends to may end without a newline. */
	flush(): PositionedLine | null {
		if (this.carryBytes === 0) return null;
		const line = {
			...joinLine(this.carry, this.carryBytes),
			start: this.lineStart,
			end: this.pos,
		};
		this.lineStart = this.pos;
		this.carry = [];
		this.carryBytes = 0;
		return line;
	}
}

/** A file's lines from one offset to another, oldest first, read forward in chunks. */
class ForwardRange {
	private readonly splitter: ForwardLines;
	private pending: PositionedLine[] = [];
	private taken = 0;

	constructor(
		private readonly handle: LogFileHandle,
		private pos: number,
		private readonly end: number,
		private readonly chunkBytes: number,
		private readonly counter: ScanCounter
	) {
		this.splitter = new ForwardLines(pos);
	}

	hasMore(): boolean {
		return this.taken < this.pending.length || this.pos < this.end || this.splitter.holds();
	}

	async next(): Promise<PositionedLine | null> {
		while (this.taken === this.pending.length) {
			if (this.pos >= this.end) return this.takeLastLine();
			await this.readChunk();
		}
		return this.pending[this.taken++];
	}

	private async readChunk(): Promise<void> {
		const start = this.pos;
		const length = Math.min(this.chunkBytes, this.end - start);
		const chunk = await readAt(this.handle, start, length, this.counter);
		if (chunk.length !== length) throw new Error("A log file shrank while it was read");
		this.pos += length;
		this.pending = this.splitter.push(chunk);
		this.taken = 0;
	}

	/** At `end`, the bytes after the last newline; a live file's `end` is that newline, so it holds none. */
	private takeLastLine(): PositionedLine | null {
		return this.splitter.flush();
	}
}

interface ForwardStream {
	file: ScannedFile;
	lines: ForwardRange;
	/** Everything before here has been consumed. */
	offset: number;
	head: { entry: LogEntry; key: string; next: number } | null;
	/** The `ts` of the older neighbour, the merge key of a line that has none. */
	lastKey: string;
}

async function loadForwardHead(stream: ForwardStream): Promise<void> {
	for (;;) {
		const line = await stream.lines.next();
		if (line === null) {
			stream.head = null;
			return;
		}
		const entry = decodeInFile(line, stream.file);
		if (entry === null) {
			stream.offset = line.end;
			continue;
		}
		const key = isUnparsedLine(entry) ? stream.lastKey : entry.ts;
		stream.head = { entry, key, next: line.end };
		return;
	}
}

function oldestHead(streams: ForwardStream[]): ForwardStream | null {
	let oldest: ForwardStream | null = null;
	for (const stream of streams) {
		if (stream.head && (oldest === null || stream.head.key < (oldest.head?.key ?? ""))) {
			oldest = stream;
		}
	}
	return oldest;
}

/**
 * Each listed file and the offset its forward read starts from. A file the
 * cursor does not name appeared after it was made, and one now shorter than
 * its offset was replaced under the same name: both are read from the start,
 * as the tail reads them.
 */
function forwardStarts(
	files: ScannedFile[],
	cursor: LogCursor
): { file: ScannedFile; start: number }[] {
	const starts = new Map<ScannedFile, number>();
	for (const entry of cursor.files) {
		const file = resolveCursorFile(files, entry);
		if (file && !starts.has(file)) starts.set(file, entry.offset);
	}
	return files.map((file) => {
		const start = starts.get(file) ?? 0;
		return { file, start: start > file.size ? 0 : start };
	});
}

async function readForward(context: ReadContext, after: LogCursor): Promise<ReadLogsResult> {
	const { files, chunkBytes, counter } = context;
	const live = liveFiles(files);
	const streams: ForwardStream[] = [];
	/**
	 * Listed files that were gone or no longer that file when opened: a rotation
	 * between the listing and the open. Each keeps its place in the cursor, so the
	 * next page finds it by identity (as `.1`) and continues where it was, rather
	 * than reading it as a file that appeared since, from its start.
	 */
	const unopened: LogCursorFile[] = [];
	for (const { file, start } of forwardStarts(files, after)) {
		const handle = await openForRead(context, file);
		if (!handle) {
			unopened.push(cursorEntry(file, start));
			continue;
		}
		const end = live.has(file.name)
			? await completeLinesEnd(handle, file.size, chunkBytes, counter)
			: file.size;
		const stream: ForwardStream = {
			file,
			lines: new ForwardRange(handle, start, end, chunkBytes, counter),
			offset: start,
			head: null,
			lastKey: "",
		};
		await loadForwardHead(stream);
		streams.push(stream);
	}
	const result = await mergeOldestFirst(streams, context);
	if (unopened.length === 0) return result;
	return {
		...result,
		cursor: { files: [...result.cursor.files, ...unopened] },
		// Not read, so not known to be at its end: the next page looks again.
		more: true,
	};
}

async function mergeOldestFirst(
	streams: ForwardStream[],
	{ matches, limit, budget, counter }: ReadContext
): Promise<ReadLogsResult> {
	const records: LogEntry[] = [];
	let scannedTo: string | null = null;
	for (let stream = oldestHead(streams); stream?.head; stream = oldestHead(streams)) {
		const { entry, key, next } = stream.head;
		stream.head = null;
		stream.offset = next;
		stream.lastKey = key;
		if (!isUnparsedLine(entry)) scannedTo = entry.ts;
		if (matches(entry)) records.push(entry);
		if (records.length >= limit || counter.bytes >= budget) break;
		await loadForwardHead(stream);
	}
	return {
		records,
		// Every file read, at its end too: a file the next call finds missing from
		// the cursor is one that appeared since.
		cursor: { files: streams.map((stream) => cursorEntry(stream.file, stream.offset)) },
		more: streams.some((stream) => stream.head !== null || stream.lines.hasMore()),
		scannedTo,
	};
}

// ---------------------------------------------------------------------------
// Tail

interface TailedFile {
	offset: number;
	lines: ForwardLines;
	lastKey: string;
}

interface KeyedEntry {
	entry: LogEntry;
	key: string;
}

/**
 * A file is followed by identity, so a rotation (the open file renamed to
 * `.1`) reads the rest of the renamed file and then the fresh one from its
 * start. Without an inode the name stands in and a rotation reads as a
 * truncation.
 */
function tailKey(file: ScannedFile): string {
	return file.id === "" ? `name:${file.name}` : file.id;
}

/**
 * Follow the log files: every `LOG_TAIL_POLL_MS` (no `fs.watch`, which is not
 * dependable across the three platforms) read what was appended to each file
 * and deliver the matching records, oldest first. Records already in a file
 * when the tail starts are the backward read's, not the tail's; a file that
 * appears later (a restarted engine) is read from its start.
 */
export async function createLogTail(deps: LogTailDeps, options: LogTailOptions): Promise<LogTail> {
	const matches = compileLogFilter(options.filter);
	const chunkBytes = deps.chunkBytes ?? CHUNK_BYTES;
	const budget = deps.scanBudgetBytes ?? LOG_SCAN_BUDGET_BYTES;
	const tracked = new Map<string, TailedFile>();
	const counter: ScanCounter = { bytes: 0 };
	for (const file of await scanLogFiles(deps)) {
		const handle = await openListed(deps, file);
		if (!handle) continue;
		try {
			// From the end of its last complete line, so a line mid-write when the
			// tail starts is delivered whole once its newline arrives.
			const offset = await completeLinesEnd(handle, file.size, chunkBytes, counter);
			tracked.set(tailKey(file), { offset, lines: new ForwardLines(offset), lastKey: "" });
		} finally {
			await handle.close();
		}
	}

	let stopped = false;
	let timer: unknown = null;

	const readAppended = async (
		file: ScannedFile,
		state: TailedFile,
		poll: ScanCounter,
		collected: KeyedEntry[]
	) => {
		const handle = await openListed(deps, file);
		if (!handle) return;
		try {
			const end = Math.min(file.size, state.offset + Math.max(0, budget - poll.bytes));
			while (state.offset < end) {
				const length = Math.min(chunkBytes, end - state.offset);
				const chunk = await readAt(handle, state.offset, length, poll);
				if (chunk.length === 0) break;
				state.offset += chunk.length;
				for (const line of state.lines.push(chunk)) {
					const entry = decodeInFile(line, file);
					if (entry === null) continue;
					if (!isUnparsedLine(entry)) state.lastKey = entry.ts;
					if (matches(entry)) collected.push({ entry, key: state.lastKey });
				}
			}
		} finally {
			await handle.close();
		}
	};

	const pollOnce = async () => {
		const files = await scanLogFiles(deps);
		const poll: ScanCounter = { bytes: 0 };
		const seen = new Set<string>();
		const collected: KeyedEntry[] = [];
		// Followed files first, so a rotated file's last records come before the
		// fresh file's first.
		const ordered = [
			...files.filter((file) => tracked.has(tailKey(file))),
			...files.filter((file) => !tracked.has(tailKey(file))),
		];
		for (const file of ordered) {
			const key = tailKey(file);
			seen.add(key);
			let state = tracked.get(key);
			if (!state || file.size < state.offset) {
				state = { offset: 0, lines: new ForwardLines(0), lastKey: "" };
				tracked.set(key, state);
			}
			if (file.size === state.offset || poll.bytes >= budget) continue;
			try {
				await readAppended(file, state, poll, collected);
			} catch {
				// @deliberate one file that cannot be read this poll (locked for a
				// moment on Windows) leaves its offset where reading stopped, and
				// the next poll continues from there; the other files still deliver.
			}
		}
		for (const key of tracked.keys()) if (!seen.has(key)) tracked.delete(key);
		if (stopped || collected.length === 0) return;
		collected.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
		const dropped = Math.max(0, collected.length - LOG_TAIL_BATCH_MAX);
		options.onBatch({ records: collected.slice(dropped).map((item) => item.entry), dropped });
	};

	const schedule = () => {
		if (stopped) return;
		timer = deps.timers.setTimeout(() => {
			timer = null;
			pollOnce()
				.catch(() => {
					// @deliberate a poll whose listing fails (the directory being
					// replaced) is retried by the next one; logging it would write to
					// the files being followed.
				})
				.finally(schedule);
		}, LOG_TAIL_POLL_MS);
	};
	schedule();

	return {
		stop() {
			stopped = true;
			if (timer !== null) deps.timers.clearTimeout(timer);
			timer = null;
		},
	};
}
