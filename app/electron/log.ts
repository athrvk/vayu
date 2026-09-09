/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file log.ts
 * @brief The app-side half of the structured logger (#1556, #1557, #1558).
 *
 * Mirrors the engine's `LogRecord` (`docs/engine/logging.md`,
 * `docs/engine/log-record.schema.json`) and its redaction rule
 * (`engine/include/vayu/utils/log_redact.hpp`) so the app's log file and the
 * engine's are interchangeable: the same required keys, the same
 * `"<redacted>"` and URL-stripping behaviour, the same JSON-lines file shape,
 * the same text console rendering. `src` here is always `"app"`, `"mcp"` or
 * `"renderer"` - `"engine"` and `"cli"` are the engine's own binaries.
 *
 * `createLogger` is Electron-free and generic - `mcp/cli.ts` (a standalone
 * process with no `app` module) calls it directly. `appLogger()` and
 * `mcpLogger()` are the lazy, Electron-coupled singletons every main-process
 * module shares, so a category from `sidecar.ts` and one from the
 * Electron-hosted MCP transport land in the same `app_<stamp>.log` file
 * through the same buffered floor.
 */

import fs from "fs";
import path from "path";
import { APP_LOG_MAX_BYTES, APP_LOG_RETENTION_COUNT } from "./constants.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSrc = "app" | "mcp" | "renderer";
/** The `cat` values the schema's `app`/`mcp` branch allows. */
export type AppCategory =
	"main" | "sidecar" | "window" | "updater" | "ipc" | "mcp" | "power" | "notify";
/** The `cat` values the schema's `renderer` branch allows. */
export type RendererCategory = "renderer" | "boundary";

export type LogFields = Record<string, unknown>;

/** One line of the file sink, or one line of the console renderer. */
export interface LogRecord {
	ts: string;
	level: LogLevel;
	src: LogSrc;
	cat: string;
	msg: string;
	pid: number;
	[field: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Field names redacted wholesale to `"<redacted>"`. Ported verbatim from
 * `kSecretFieldNames` in `engine/include/vayu/utils/log_redact.hpp` so a
 * record either side emits redacts the same fields.
 */
const SECRET_FIELD_NAMES = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"www-authenticate",
	"proxy-authenticate",
	"authentication-info",
	"token",
	"access_token",
	"refresh_token",
	"client_secret",
	"password",
	"apikey",
	"x-api-key",
]);

function isSecretFieldName(name: string): boolean {
	return SECRET_FIELD_NAMES.has(name.toLowerCase());
}

/** A field whose name ends `url`/`Url` (`proxyUrl`, `url`, `refreshTokenUrl`, ...). */
function isUrlFieldName(name: string): boolean {
	return name.toLowerCase().endsWith("url");
}

/**
 * Strip a URL (or a bare path-and-query) to scheme, host and path, dropping
 * `user:pass@` and the whole query string. A line-for-line port of
 * `strip_url_secrets` in `log_redact.hpp`: `https://u:p@h/x?y=1` becomes
 * `https://h/x`; `/p?api_key=S HTTP/1.1` becomes `/p HTTP/1.1`.
 */
function stripUrlSecrets(url: string): string {
	let rest = url;
	let prefix = "";

	const schemeEnd = rest.indexOf("://");
	if (schemeEnd !== -1) {
		const hostStart = schemeEnd + 3;
		const pathStart = rest.indexOf("/", hostStart);
		let authority = pathStart === -1 ? rest.slice(hostStart) : rest.slice(hostStart, pathStart);
		const at = authority.indexOf("@");
		if (at !== -1) authority = authority.slice(at + 1);
		prefix = rest.slice(0, schemeEnd + 3) + authority;
		rest = pathStart === -1 ? "" : rest.slice(pathStart);
	}

	let suffix = "";
	const query = rest.indexOf("?");
	if (query !== -1) {
		const afterQuery = rest.indexOf(" ", query);
		if (afterQuery !== -1) suffix = rest.slice(afterQuery);
		rest = rest.slice(0, query);
	}

	return prefix + rest + suffix;
}

/** Redact @p node at every depth, matching `redact_fields` in `log_redact.hpp`. */
function redactFields(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(redactFields);
	if (node !== null && typeof node === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (isSecretFieldName(key)) {
				result[key] = "<redacted>";
			} else if (typeof value === "string" && isUrlFieldName(key)) {
				result[key] = stripUrlSecrets(value);
			} else {
				result[key] = redactFields(value);
			}
		}
		return result;
	}
	return node;
}

function levelConsoleName(level: LogLevel): string {
	switch (level) {
		case "debug":
			return "DEBUG";
		case "info":
			return "INFO";
		case "warn":
			return "WARNING";
		case "error":
			return "ERROR";
	}
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

const RESERVED_KEYS = new Set(["ts", "level", "src", "cat", "msg", "pid", "tid"]);

/**
 * `"HH:MM:SS.mmm LEVEL cat      msg k=v ..."` - the same shape on every
 * console, engine or app (`engine/src/utils/logger.cpp`'s
 * `write_to_console_locked`: level padded to 7, category to 9, both
 * left-justified).
 */
function renderConsoleLine(record: LogRecord): string {
	let line = `${record.ts.slice(11, 23)} ${pad(levelConsoleName(record.level), 7)}${pad(record.cat, 9)}${record.msg}`;
	for (const [key, value] of Object.entries(record)) {
		if (RESERVED_KEYS.has(key)) continue;
		line += ` ${key}=${typeof value === "string" ? value : JSON.stringify(value)}`;
	}
	return line;
}

/** File-name stamp, matching the engine's `%Y%m%d_%H%M%S` (`logger.cpp`). */
function fileStamp(now: Date): string {
	const p2 = (n: number) => n.toString().padStart(2, "0");
	return (
		`${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}_` +
		`${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}`
	);
}

function existingSize(filePath: string): number {
	try {
		return fs.statSync(filePath).size;
	} catch {
		return 0;
	}
}

/**
 * Delete every `<prefix>_*.log` file in @p dir past the newest @p keep,
 * oldest first - the file-name stamp sorts lexically, so a plain sort is
 * chronological. Mirrors `prune_old_logs` in `engine/src/utils/logger.cpp`.
 */
function pruneOldLogs(dir: string, prefix: string, keep: number): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	const owned = entries
		.filter((name) => name.startsWith(`${prefix}_`) && name.endsWith(".log"))
		.sort();
	const stale = owned.slice(0, Math.max(0, owned.length - keep));
	for (const name of stale) {
		try {
			fs.rmSync(path.join(dir, name), { force: true });
			fs.rmSync(path.join(dir, `${name}.1`), { force: true });
		} catch {
			// @deliberate best-effort cleanup - a file another process still holds
			// open (Windows) is left for the next prune, not worth failing a log
			// call over.
		}
	}
}

interface ChannelOptions {
	logsDir: string | null;
	filePrefix: string;
	consoleEnabled: boolean;
	/** `true`: error to stderr, else stdout (the app). `false`: everything to
	 *  stderr - stdout is reserved (the MCP stdio server). */
	consoleSplitByLevel: boolean;
	now: () => Date;
	/** Defaults to `APP_LOG_MAX_BYTES`; overridable so a test can force a rotation. */
	maxFileBytes: number;
	/** Defaults to `APP_LOG_RETENTION_COUNT`; overridable for the same reason. */
	retentionCount: number;
}

/**
 * The shared state behind every `Logger` that targets the same file: the
 * buffer-until-floor-known queue, the current file path, rotation and
 * retention. Keyed by `logsDir` + `filePrefix` so an "app" logger and an
 * "mcp" logger that both write `app_<stamp>.log` share one file, one buffer
 * and one floor rather than racing each other.
 */
class LogChannel {
	private pending: LogRecord[] | null = [];
	private floor: LogLevel | null = null;
	private filePath: string | null = null;
	private currentBytes = 0;
	private retentionSwept = false;

	constructor(private readonly opts: ChannelOptions) {}

	emit(record: LogRecord): void {
		if (this.floor === null) {
			this.pending?.push(record);
			return;
		}
		this.deliver(record);
	}

	/** No-op past the first call - `logLevel` is read once per launch. */
	applyFloor(level: LogLevel): void {
		if (this.floor !== null) return;
		this.floor = level;
		const buffered = this.pending ?? [];
		this.pending = null;
		for (const record of buffered) this.deliver(record);
	}

	private deliver(record: LogRecord): void {
		if (LEVEL_ORDER[record.level] < LEVEL_ORDER[this.floor as LogLevel]) return;
		this.writeToFile(record);
		this.writeToConsole(record);
	}

	private writeToConsole(record: LogRecord): void {
		if (!this.opts.consoleEnabled) return;
		const line = renderConsoleLine(record);
		const toStderr = this.opts.consoleSplitByLevel ? record.level === "error" : true;
		if (toStderr) process.stderr.write(line + "\n");
		else process.stdout.write(line + "\n");
	}

	/**
	 * Synchronous, deliberately: a main-process logger writes at most a few
	 * lines a second, never a per-request hot path the way the engine's own
	 * sink is, and a `WriteStream`'s asynchronous open leaves a window where a
	 * line is accepted but not yet on disk - observable, and worth avoiding,
	 * the moment anything (a crash handler flushing on the way out, a test)
	 * reads the file right after a call returns.
	 */
	private writeToFile(record: LogRecord): void {
		if (!this.opts.logsDir) return;
		if (!this.ensureFile(this.opts.logsDir)) return;
		const line = JSON.stringify(record) + "\n";
		const bytes = Buffer.byteLength(line);
		if (this.opts.maxFileBytes > 0 && this.currentBytes + bytes > this.opts.maxFileBytes) {
			this.rotate();
		}
		try {
			fs.appendFileSync(this.filePath as string, line);
			this.currentBytes += bytes;
		} catch {
			// @deliberate a full disk or a yanked volume is not worth losing every
			// later record over - the next call tries again.
		}
	}

	/** Returns whether `this.filePath` is now usable. */
	private ensureFile(logsDir: string): boolean {
		if (this.filePath) return true;
		try {
			fs.mkdirSync(logsDir, { recursive: true });
		} catch {
			return false;
		}
		if (!this.retentionSwept) {
			this.retentionSwept = true;
			pruneOldLogs(logsDir, this.opts.filePrefix, this.opts.retentionCount);
		}
		this.filePath = path.join(
			logsDir,
			`${this.opts.filePrefix}_${fileStamp(this.opts.now())}.log`
		);
		this.currentBytes = existingSize(this.filePath);
		return true;
	}

	private rotate(): void {
		if (!this.filePath) return;
		const rotatedPath = `${this.filePath}.1`;
		try {
			fs.rmSync(rotatedPath, { force: true });
			fs.renameSync(this.filePath, rotatedPath);
		} catch {
			// @deliberate a rename that fails (permissions, a file another
			// process holds on Windows) is not worth losing every later record
			// over - the file keeps growing past the cap instead.
		}
		this.currentBytes = 0;
	}
}

const channels = new Map<string, LogChannel>();

function getChannel(opts: ChannelOptions): LogChannel {
	const key = `${opts.logsDir ?? ""} ${opts.filePrefix} ${opts.consoleSplitByLevel}`;
	let channel = channels.get(key);
	if (!channel) {
		channel = new LogChannel(opts);
		channels.set(key, channel);
	}
	return channel;
}

export interface Logger {
	debug(cat: string, msg: string, fields?: LogFields): void;
	info(cat: string, msg: string, fields?: LogFields): void;
	warn(cat: string, msg: string, fields?: LogFields): void;
	error(cat: string, msg: string, fields?: LogFields): void;
	/**
	 * Apply the floor learned from the engine's `logLevel` (or `"debug"` as
	 * the launch-failed fallback, see `applyFloorFromEngine`) and flush every
	 * record buffered before it was known. No-op past the first call.
	 */
	applyFloor(level: LogLevel): void;
}

export interface CreateLoggerOptions {
	/** Where the file sink writes, or `null` to skip the file entirely. */
	logsDir: string | null;
	/** File name prefix; the file is `<filePrefix>_<stamp>.log`. Default `"app"`. */
	filePrefix?: string;
	consoleEnabled: boolean;
	/** See `ChannelOptions`. Default `true` (the app's own split). */
	consoleSplitByLevel?: boolean;
	now?: () => Date;
	pid?: number;
	/** Defaults to `APP_LOG_MAX_BYTES`; overridable so a test can force a rotation. */
	maxFileBytes?: number;
	/** Defaults to `APP_LOG_RETENTION_COUNT`; overridable for the same reason. */
	retentionCount?: number;
}

/**
 * Build a logger for one `src`. Electron-free: `mcp/cli.ts` (a standalone
 * process with no `app` module) calls this directly with its own options.
 * Two loggers built with the same `logsDir` + `filePrefix` share one
 * `LogChannel` - see its doc comment.
 */
export function createLogger(src: LogSrc, options: CreateLoggerOptions): Logger {
	const now = options.now ?? (() => new Date());
	const pid = options.pid ?? process.pid;
	const channel = getChannel({
		logsDir: options.logsDir,
		filePrefix: options.filePrefix ?? "app",
		consoleEnabled: options.consoleEnabled,
		consoleSplitByLevel: options.consoleSplitByLevel ?? true,
		now,
		maxFileBytes: options.maxFileBytes ?? APP_LOG_MAX_BYTES,
		retentionCount: options.retentionCount ?? APP_LOG_RETENTION_COUNT,
	});

	function log(level: LogLevel, cat: string, msg: string, fields?: LogFields): void {
		const record = redactFields({
			ts: now().toISOString(),
			level,
			src,
			cat,
			msg,
			pid,
			...fields,
		}) as LogRecord;
		channel.emit(record);
	}

	return {
		debug: (cat, msg, fields) => log("debug", cat, msg, fields),
		info: (cat, msg, fields) => log("info", cat, msg, fields),
		warn: (cat, msg, fields) => log("warn", cat, msg, fields),
		error: (cat, msg, fields) => log("error", cat, msg, fields),
		applyFloor: (level) => channel.applyFloor(level),
	};
}

const KNOWN_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

/**
 * Fetch the engine's `logLevel` from `GET <baseUrl>/config` and apply it as
 * this logger's floor, once. Falls back to `"debug"` on any failure - a
 * launch that could not reach the engine is exactly the one whose every
 * record is wanted.
 */
export async function applyFloorFromEngine(logger: Logger, baseUrl: string): Promise<void> {
	try {
		const response = await fetch(`${baseUrl}/config`);
		if (!response.ok) throw new Error(`config responded ${response.status}`);
		const config = (await response.json()) as { entries?: { key?: string; value?: string }[] };
		const raw = config?.entries?.find((entry) => entry.key === "logLevel")?.value;
		logger.applyFloor(raw && KNOWN_LEVELS.has(raw) ? (raw as LogLevel) : "debug");
	} catch {
		logger.applyFloor("debug");
	}
}
