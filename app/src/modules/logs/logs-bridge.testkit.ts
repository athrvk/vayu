/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A fake `window.electronAPI.logs` for the Logs tab's tests (#3635), and the
 * lines to feed it. `push` is the main process delivering a tail batch; every
 * method is a `vi.fn` the case can read the filter and cursor off.
 *
 * Every line carries its `$pos`, as the reader's do. `logRecord(n)` is line `n`
 * of one engine file at one byte a line, so it starts at offset `n` and a
 * backward `logCursor(n)` continues with line `n - 1`. `serveLog` answers the
 * reads over any lines the way the reader does, per file from the cursor, and
 * `pushPoll` orders a batch the way the tail's poll does, by time.
 */

import { vi } from "vitest";
import type {
	LogBatch,
	LogCursor,
	LogEntry,
	LogFileRecord,
	LogFilter,
	LogLinePosition,
	LogReadRequest,
	LogReadResult,
} from "@/types/electron";
import { isUnparsedEntry } from "./log-entry";

const NO_MORE: LogReadResult = { records: [], cursor: { files: [] }, more: false, scannedTo: null };

/** Which way a read goes: the newest lines, or from one of the request's anchors. */
export type LogReadKind = "newest" | "before" | "around" | "after";

function readKind(request: LogReadRequest): LogReadKind {
	if (request.before) return "before";
	if (request.around !== undefined) return "around";
	if (request.after) return "after";
	return "newest";
}

/** The file `logRecord` and `logCursor` are in, as a cursor entry names it. */
export const ENGINE_LOG = { name: "engine_20261118_100000.log", id: "1:2" };

/** A cursor a case can tell from another by `===` and by its offset. */
export function logCursor(offset: number): LogCursor {
	return { files: [{ ...ENGINE_LOG, offset }] };
}

const FIRST_TS = Date.UTC(2026, 10, 18, 10, 0, 0);

/**
 * A record, `ts` one second after the previous @p n, so a list of them is in
 * time order; it is line @p n of `ENGINE_LOG`, at offset @p n.
 */
export function logRecord(n: number, overrides: Partial<LogFileRecord> = {}): LogFileRecord {
	return {
		ts: new Date(FIRST_TS + n * 1000).toISOString(),
		level: "info",
		src: "engine",
		cat: "http",
		msg: `line ${n}`,
		pid: 4242,
		$pos: { ...ENGINE_LOG, start: n, end: n + 1 },
		...overrides,
	};
}

function positionOf(entry: LogEntry): LogLinePosition {
	if (!entry.$pos) throw new Error(`A fixture line without a position: ${JSON.stringify(entry)}`);
	return entry.$pos;
}

function sameFile(
	a: Pick<LogLinePosition, "name" | "id">,
	b: Pick<LogLinePosition, "name" | "id">
) {
	return a.id === "" ? a.name === b.name : a.id === b.id;
}

/**
 * The page older the reader answers over @p log for @p before: per cursor
 * file, its lines that end at or before the offset, merged newest first by
 * `ts` (a line without one keeps the time of the line after it in its file),
 * at most @p limit, and a cursor at each file's oldest line taken.
 */
function readBefore(log: readonly LogEntry[], before: LogCursor, limit: number): LogReadResult {
	const streams = before.files.map((file) => ({
		file,
		offset: file.offset,
		lines: log
			.filter(
				(entry) => sameFile(positionOf(entry), file) && positionOf(entry).end <= file.offset
			)
			.sort((a, b) => positionOf(b).start - positionOf(a).start),
		key: "\uffff",
	}));
	const keyOf = (stream: (typeof streams)[number]) => {
		const head = stream.lines[0];
		return isUnparsedEntry(head) ? stream.key : head.ts;
	};
	const newestFirst: LogEntry[] = [];
	while (newestFirst.length < limit) {
		const open = streams.filter((stream) => stream.lines.length > 0);
		if (open.length === 0) break;
		const stream = open.reduce((newest, other) =>
			keyOf(other) > keyOf(newest) ? other : newest
		);
		stream.key = keyOf(stream);
		const entry = stream.lines.shift() as LogEntry;
		stream.offset = positionOf(entry).start;
		newestFirst.push(entry);
	}
	const records = newestFirst.reverse();
	const oldest = records.find((entry) => !isUnparsedEntry(entry));
	return {
		records,
		cursor: {
			files: streams
				.filter((stream) => stream.offset > 0)
				.map((stream) => ({ ...stream.file, offset: stream.offset })),
		},
		more: streams.some((stream) => stream.lines.length > 0),
		scannedTo: oldest && !isUnparsedEntry(oldest) ? oldest.ts : null,
	};
}

/**
 * @p records, each file's in file order, as a tail poll orders its batch: by
 * `ts`, stably, an unparsed line keyed by the line before it in its file
 * (`collected.sort` in `electron/log-reader.ts`). A line whose `ts` is behind
 * the line before it in its file arrives ahead of it, out of offset order.
 */
function inPollOrder(records: readonly LogEntry[]): LogEntry[] {
	const lastKey = new Map<string, string>();
	const keyed = records.map((entry) => {
		const { name, id } = positionOf(entry);
		const file = id === "" ? `name:${name}` : `id:${id}`;
		const key = isUnparsedEntry(entry) ? (lastKey.get(file) ?? "") : entry.ts;
		lastKey.set(file, key);
		return { entry, key };
	});
	keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return keyed.map(({ entry }) => entry);
}

/** A cursor at the end of every file @p log has lines in: where the newest read starts. */
function cursorAtEnds(log: readonly LogEntry[]): LogCursor {
	const files: LogCursor["files"] = [];
	for (const entry of log) {
		const { name, id, end } = positionOf(entry);
		const file = files.find((other) => sameFile(other, { name, id }));
		if (!file) files.push({ name, id, offset: end });
		else file.offset = Math.max(file.offset, end);
	}
	return { files };
}

export function fakeLogsBridge() {
	const listeners = new Set<(batch: LogBatch) => void>();
	const logs = {
		list: vi.fn(async () => []),
		read: vi.fn(async (_request: LogReadRequest): Promise<LogReadResult> => NO_MORE),
		tailStart: vi.fn(async (_filter: LogFilter) => undefined),
		tailStop: vi.fn(async () => undefined),
		onRecords: vi.fn((callback: (batch: LogBatch) => void) => {
			listeners.add(callback);
			return () => {
				listeners.delete(callback);
			};
		}),
	};
	return {
		logs,
		/** How many callbacks are subscribed to the tail right now. */
		subscribers: () => listeners.size,
		/** What main does: deliver one tail batch to everything subscribed. */
		push: (records: LogEntry[], dropped = 0) => {
			for (const listener of [...listeners]) listener({ records, dropped });
		},
		/** `push`, with @p records in the order the tail's poll sorts a batch into (`inPollOrder`). */
		pushPoll: (records: readonly LogEntry[], dropped = 0) => {
			const batch = inPollOrder(records);
			for (const listener of [...listeners]) listener({ records: batch, dropped });
		},
		/** The answer the next reads give, until it is set again. */
		answer: (result: Partial<LogReadResult>) => {
			logs.read.mockResolvedValue({ ...NO_MORE, ...result });
		},
		/**
		 * The reads answer from @p log as the reader would: the newest from every
		 * file's end, a page older by `readBefore`. Until it is set again.
		 */
		serveLog: (log: readonly LogEntry[]) => {
			logs.read.mockImplementation(async (request: LogReadRequest) =>
				readBefore(log, request.before ?? cursorAtEnds(log), request.limit)
			);
		},
		/** The answer the next reads give by the way each one goes, until it is set again. */
		answerReads: (answers: Partial<Record<LogReadKind, Partial<LogReadResult>>>) => {
			logs.read.mockImplementation(async (request: LogReadRequest) => ({
				...NO_MORE,
				...answers[readKind(request)],
			}));
		},
	};
}

export type FakeLogsBridge = ReturnType<typeof fakeLogsBridge>;
