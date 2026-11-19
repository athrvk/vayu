/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file log-reader-ipc.ts
 * @brief The Logs tab's IPC (#3635) over `log-reader.ts`: `logs:list` and
 *        `logs:read` (invoke), `logs:tail-start` / `logs:tail-stop` (invoke),
 *        and `logs:records`, the one-way push main sends the tailing renderer.
 *
 * The log files are the user's data and include what the app logged about
 * them, so every handler answers only the app window's main frame
 * (`ipc-sender.ts`). A renderer names no path: it sends names it was given by
 * `logs:list` and cursors it was given by `logs:read`, and the reader resolves
 * both through its own listing. What this module adds is the shape check of
 * what the wire carries, since the reader's own checks start from its types.
 *
 * One tail per renderer: a second `logs:tail-start` replaces the first, and a
 * tail ends with `logs:tail-stop`, its renderer being destroyed or navigating,
 * or the app quitting (`stopAll`). The tail's batches go out as they arrive;
 * nothing here logs per batch, since a log line written while tailing is
 * itself a line for the tail to deliver. The reply types are the reader's
 * (`ReadLogsResult`, `LogBatch`), mirrored by `electronAPI.logs` in
 * `preload.ts` and `src/types/electron.d.ts`, neither of which can import.
 */

import { LEVEL_ORDER } from "./log.js";
import type { IpcSenderLike } from "./ipc-sender.js";
import {
	createLogTail,
	listLogFiles,
	readLogs,
	type LogBatch,
	type LogCursor,
	type LogFieldTerm,
	type LogFilter,
	type LogReaderFs,
	type LogTail,
	type LogTailTimers,
	type ReadLogsOptions,
} from "./log-reader.js";
import { createRendererWatch, type RendererLike } from "./renderer-watch.js";

export const LOGS_LIST_CHANNEL = "logs:list";
export const LOGS_READ_CHANNEL = "logs:read";
export const LOGS_TAIL_START_CHANNEL = "logs:tail-start";
export const LOGS_TAIL_STOP_CHANNEL = "logs:tail-stop";
/** Main to renderer, one-way, carrying a `LogBatch`. */
export const LOGS_RECORDS_CHANNEL = "logs:records";

/** The renderer that sent a message, which is also where its tail's batches go. */
export interface LogReaderSender extends RendererLike {
	send(channel: string, payload: LogBatch): void;
}

export interface LogReaderEvent extends IpcSenderLike {
	sender: LogReaderSender;
}

interface IpcLike {
	handle(
		channel: string,
		listener: (event: LogReaderEvent, ...args: unknown[]) => unknown
	): unknown;
}

export interface LogReaderIpcDeps {
	/** `isFromAppMainFrame` against the live main window. */
	isAppFrame: (event: IpcSenderLike) => boolean;
	/** The logs directory, read at each call: it follows the data directory. */
	logsPath: () => string;
	fs: LogReaderFs;
	timers: LogTailTimers;
	/** Defaults to `createRendererWatch`; a test passes one it can fire. */
	createRendererWatch?: typeof createRendererWatch;
}

export interface LogReaderIpc {
	/** Ends every renderer's tail; the app is quitting. */
	stopAll(): void;
}

// ---------------------------------------------------------------------------
// The wire's shape

function refuse(what: string): never {
	throw new Error(`Refused: a log request ${what}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (!isRecord(value)) refuse(`needs ${what} to be an object`);
	return value;
}

function stringList(value: unknown, what: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		refuse(`needs ${what} to be a list of text`);
	}
	return value;
}

function fieldTerm(value: unknown): LogFieldTerm {
	const term = asRecord(value, "each term");
	const { field, value: text, exact } = term;
	if (typeof field !== "string" || typeof text !== "string" || typeof exact !== "boolean") {
		refuse("needs each term to be a field and a value of text and an exact flag");
	}
	return { field, value: text, exact };
}

/** @p value as a `LogFilter` holding only the keys the reader reads; throws on any wrong type. */
export function readLogFilter(value: unknown): LogFilter {
	const input = asRecord(value, "the filter");
	const filter: LogFilter = {};
	if (input.minLevel !== undefined) {
		if (
			typeof input.minLevel !== "string" ||
			!Object.prototype.hasOwnProperty.call(LEVEL_ORDER, input.minLevel)
		) {
			refuse("needs the minimum level to be debug, info, warn or error");
		}
		filter.minLevel = input.minLevel as LogFilter["minLevel"];
	}
	if (input.sources !== undefined) filter.sources = stringList(input.sources, "the sources");
	if (input.categories !== undefined) {
		filter.categories = stringList(input.categories, "the categories");
	}
	if (input.text !== undefined) {
		if (typeof input.text !== "string") refuse("needs the text to be text");
		filter.text = input.text;
	}
	if (input.terms !== undefined) {
		if (!Array.isArray(input.terms)) refuse("needs the terms to be a list");
		filter.terms = input.terms.map(fieldTerm);
	}
	return filter;
}

function cursorFile(value: unknown): LogCursor["files"][number] {
	const file = asRecord(value, "each cursor entry");
	const { name, id, offset } = file;
	if (typeof name !== "string" || typeof id !== "string" || typeof offset !== "number") {
		refuse("needs each cursor entry to be a name and an id of text and an offset number");
	}
	return { name, id, offset };
}

function readCursor(value: unknown): LogCursor {
	const cursor = asRecord(value, "the cursor");
	if (!Array.isArray(cursor.files)) refuse("needs the cursor to carry a list of files");
	return { files: cursor.files.map(cursorFile) };
}

/**
 * `logs:read`'s payload as the reader's options. The reader checks the values
 * (a name against the log file pattern, an offset a whole number, `around` a
 * timestamp, one of `before`, `around` and `after`); this checks that each is
 * the type it will be asked to compare.
 */
export function readLogsRequest(value: unknown): ReadLogsOptions {
	const input = asRecord(value, "the payload");
	if (typeof input.limit !== "number") refuse("needs a limit that is a number");
	const options: ReadLogsOptions = { filter: readLogFilter(input.filter), limit: input.limit };
	if (input.before !== undefined) options.before = readCursor(input.before);
	if (input.after !== undefined) options.after = readCursor(input.after);
	if (input.around !== undefined) {
		if (typeof input.around !== "string") refuse("needs `around` to be a timestamp of text");
		options.around = input.around;
	}
	return options;
}

// ---------------------------------------------------------------------------
// Handlers

function requireAppFrame(deps: LogReaderIpcDeps, event: LogReaderEvent): void {
	if (!deps.isAppFrame(event)) {
		throw new Error("Refused: logs are read only from the Vayu window.");
	}
}

export function registerLogReaderIpc(ipc: IpcLike, deps: LogReaderIpcDeps): LogReaderIpc {
	const readerDeps = () => ({ fs: deps.fs, logsDir: deps.logsPath() });
	const tails = new Map<number, LogTail>();
	/**
	 * What a start is waiting on: `createLogTail` is async, so a stop or a
	 * second start can land while the first is still opening files, and the
	 * tail it then returns must not be kept.
	 */
	const starts = new Map<number, symbol>();

	const stopTail = (rendererId: number): void => {
		starts.delete(rendererId);
		tails.get(rendererId)?.stop();
		tails.delete(rendererId);
	};

	const watch = (deps.createRendererWatch ?? createRendererWatch)(stopTail);

	async function startTail(event: LogReaderEvent, filterValue: unknown): Promise<void> {
		const filter = readLogFilter(filterValue);
		const { sender } = event;
		stopTail(sender.id);
		watch(sender);
		const start = Symbol("log tail start");
		starts.set(sender.id, start);
		try {
			const tail = await createLogTail(
				{ ...readerDeps(), timers: deps.timers },
				{ filter, onBatch: (batch) => sender.send(LOGS_RECORDS_CHANNEL, batch) }
			);
			if (starts.get(sender.id) !== start) {
				tail.stop();
				return;
			}
			tails.set(sender.id, tail);
		} finally {
			if (starts.get(sender.id) === start) starts.delete(sender.id);
		}
	}

	ipc.handle(LOGS_LIST_CHANNEL, (event) => {
		requireAppFrame(deps, event);
		return listLogFiles(readerDeps());
	});

	ipc.handle(LOGS_READ_CHANNEL, (event, ...args) => {
		requireAppFrame(deps, event);
		return readLogs(readerDeps(), readLogsRequest(args[0]));
	});

	ipc.handle(LOGS_TAIL_START_CHANNEL, (event, ...args) => {
		requireAppFrame(deps, event);
		return startTail(event, args[0]);
	});

	ipc.handle(LOGS_TAIL_STOP_CHANNEL, (event) => {
		requireAppFrame(deps, event);
		stopTail(event.sender.id);
	});

	return {
		stopAll() {
			for (const rendererId of new Set([...tails.keys(), ...starts.keys()])) {
				stopTail(rendererId);
			}
		},
	};
}
