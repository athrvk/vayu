/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file log-ipc.ts
 * @brief The two IPC channels #1558 adds: `log:record` (renderer -> main,
 *        one-way - the `runs:progress` / `icon:signal` shape - forwarding a
 *        `error-logger.ts` record onto the app's `"renderer"` logger) and
 *        `app:openLogsFolder` (Settings, General's "Open logs folder"
 *        button).
 */

import { shell } from "electron";
import { stripUrlSecretsInText, type Logger, type LogLevel, type LogFields } from "./log.js";

const KNOWN_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);
const RENDERER_CATEGORIES: ReadonlySet<string> = new Set(["renderer", "boundary"]);
/** A page that throws in a loop leaves at most this many records per second. */
const RECORDS_PER_SECOND = 20;

/** Shape a renderer sends over `log:record`, after `readRendererLogRecord`. */
export interface RendererLogRecord {
	level: LogLevel;
	cat: string;
	msg: string;
	err?: { name: string; message: string; stack?: string };
	fields?: LogFields;
}

const MSG_MAX_CHARS = 2000;
const ERR_NAME_MAX_CHARS = 200;
const ERR_MESSAGE_MAX_CHARS = 2000;
const ERR_STACK_MAX_CHARS = 8000;
const FIELD_VALUE_MAX_CHARS = 500;
const FIELDS_MAX_KEYS = 20;
const FIELDS_MAX_SERIALISED_CHARS = 4000;
const TRUNCATION_MARKER = "...[truncated]";

/**
 * Keys the logger itself owns. A renderer field of the same name would
 * overwrite the record's own (`src: "engine"` on a renderer line); `pid` is
 * not here because the handler overwrites it with the sender's.
 */
const RESERVED_FIELD_KEYS = ["ts", "level", "src", "cat", "msg", "tid"] as const;

// eslint-disable-next-line no-control-regex -- the point is to match them
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? text.slice(0, maxChars) + TRUNCATION_MARKER : text;
}

/**
 * URLs in the text lose their secrets first, then the text is cut: cutting
 * first could leave the front half of a credential that has no `@` after it
 * for the stripper to find.
 */
function boundedText(text: string, maxChars: number): string {
	return truncate(stripUrlSecretsInText(text), maxChars);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function readErr(value: unknown): RendererLogRecord["err"] {
	if (!isPlainObject(value)) return undefined;
	const { name, message, stack } = value;
	if (typeof name !== "string" || typeof message !== "string") return undefined;
	return {
		name: truncate(name, ERR_NAME_MAX_CHARS),
		message: boundedText(message, ERR_MESSAGE_MAX_CHARS),
		...(typeof stack === "string" ? { stack: boundedText(stack, ERR_STACK_MAX_CHARS) } : {}),
	};
}

function readFields(value: unknown): LogFields | undefined {
	if (!isPlainObject(value)) return undefined;
	const fields: LogFields = {};
	for (const [key, entry] of Object.entries(value).slice(0, FIELDS_MAX_KEYS)) {
		fields[key] = typeof entry === "string" ? boundedText(entry, FIELD_VALUE_MAX_CHARS) : entry;
	}
	return isWithinSerialisedBudget(fields) ? fields : { truncated: true };
}

/** A value structured clone allows but JSON does not (a cycle, a bigint) fails the budget. */
function isWithinSerialisedBudget(fields: LogFields): boolean {
	try {
		return JSON.stringify(fields).length <= FIELDS_MAX_SERIALISED_CHARS;
	} catch {
		return false;
	}
}

/**
 * The renderer's payload as a record the logger can take, or `null` when its
 * level or category is not one the schema allows. Anything else a renderer
 * sends is bounded or dropped rather than trusted: a hostile or runaway page
 * must not choose how large a line is, which field names it owns, or what
 * credentials in a URL reach the file.
 */
function readRendererLogRecord(value: unknown): RendererLogRecord | null {
	if (!isPlainObject(value)) return null;
	const { level, cat, msg } = value;
	if (typeof level !== "string" || !KNOWN_LEVELS.has(level)) return null;
	if (typeof cat !== "string" || !RENDERER_CATEGORIES.has(cat)) return null;
	if (typeof msg !== "string") return null;
	return {
		level: level as LogLevel,
		cat,
		msg: boundedText(msg, MSG_MAX_CHARS),
		err: readErr(value.err),
		fields: readFields(value.fields),
	};
}

/** One sender's per-second record count, so a render loop cannot fill the disk. */
export class RateLimiter {
	private windows = new Map<number, { startedAt: number; count: number; warned: boolean }>();

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Registers one record for @p senderId. Returns `"under"` (deliver it),
	 * `"first-over"` (the 21st in this window - drop it and warn once) or
	 * `"over"` (already warned this window - drop it silently). Distinguishing
	 * the last two is the whole point of the cap: warning on every one of a
	 * loop's thousands of drops would itself fill the disk exactly as fast as
	 * the loop would have.
	 */
	check(senderId: number): "under" | "first-over" | "over" {
		const now = this.now();
		const window = this.windows.get(senderId);
		if (!window || now - window.startedAt >= 1000) {
			this.windows.set(senderId, { startedAt: now, count: 1, warned: false });
			return "under";
		}
		window.count += 1;
		if (window.count <= RECORDS_PER_SECOND) return "under";
		if (window.warned) return "over";
		window.warned = true;
		return "first-over";
	}
}

interface IpcSender {
	sender: { id: number; getOSProcessId?: () => number };
}

interface IpcLike {
	on(channel: string, listener: (event: IpcSender, ...args: unknown[]) => void): unknown;
	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
}

interface ShellLike {
	openPath(targetPath: string): Promise<string>;
}

export function registerLogIpc(
	ipc: IpcLike,
	deps: {
		rendererLog: Logger;
		appLog: Logger;
		logsPath: () => string;
		shellApi?: ShellLike;
		rateLimiter?: RateLimiter;
	}
): void {
	const shellApi = deps.shellApi ?? shell;
	const limiter = deps.rateLimiter ?? new RateLimiter();

	ipc.on("log:record", (event, ...args: unknown[]) => {
		const senderId = event.sender.id;
		const status = limiter.check(senderId);
		if (status === "over") return;
		if (status === "first-over") {
			// The 21st record in the window is where this fires, once - every
			// later drop in the same window is silent, or the warning itself
			// would fill the disk exactly as fast as the loop being capped would.
			deps.appLog.warn("ipc", "Dropping renderer log records over the per-second cap", {
				senderId,
			});
			return;
		}

		const record = readRendererLogRecord(args[0]);
		if (!record) return;

		const fields: LogFields = { ...record.fields };
		for (const key of RESERVED_FIELD_KEYS) delete fields[key];
		if (record.err) fields.err = record.err;
		fields.pid = event.sender.getOSProcessId?.() ?? senderId;

		// Fields render as `k=v` with a JSON-escaped value, but `msg` is printed
		// raw: a newline in it would forge a second console line.
		const msg = record.msg.replace(CONTROL_CHARACTERS, " ");
		deps.rendererLog[record.level](record.cat, msg, fields);
	});

	ipc.handle("app:openLogsFolder", async () => {
		return await shellApi.openPath(deps.logsPath());
	});
}
