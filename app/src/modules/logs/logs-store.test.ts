/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Logs tab's store (#3635): the tail and the paged reads over a fake
 * `electronAPI.logs`, and the bound on what the renderer holds.
 *
 * Mutation checks: drop the `trimToBound` call in `receive` and the flood case
 * holds 10,500; drop `tailStop` from `stop` and the unmount case reds; drop the
 * `reloadFresh` call in `setControls` and the filter cases red; keep the list
 * detached in `appendNewer` and the end-of-the-logs case reds; drop the page
 * newer from `jumpTo` and the jump puts no line after the time in the list;
 * drop `pastOverlap` from `receive` and the overlap cases hold a line twice;
 * count only the raw line in `entryBytes` and the byte bound case holds twice as
 * many lines. After a trim (#3652): keep the cursor from before it and the
 * follow and Search newer cases page past a hole; set `more` false and they
 * read nothing; rebuild only the file of the first held line, or of the newest
 * line dropped, and the interleaved case skips another file's dropped lines;
 * leave out the newest dropped line of a file with none held and the byte case
 * never reads the file it dropped; start from no entries instead of the
 * previous cursor and the rotated file is never reached; let the newest line
 * dropped win over the oldest held and the burst case skips what the burst left
 * out; drop the `state.cursor !== cursor` check in `loadOlder` and the
 * in-flight case lands its page behind a hole; skip a line without a position
 * instead of ending and the unplaced case pages older.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type {
	LogEntry,
	LogFileRecord,
	LogLinePosition,
	LogReadRequest,
	LogReadResult,
} from "@/types/electron";
import { entryBytes } from "./log-entry";
import {
	ENGINE_LOG,
	fakeLogsBridge,
	logCursor,
	logRecord,
	type FakeLogsBridge,
} from "./logs-bridge.testkit";
import { LOG_MAX_BYTES, LOG_MAX_RECORDS, buildLogFilter, useLogsStore } from "./logs-store";

let bridge: FakeLogsBridge;

/** Records `from` to `from + count - 1`, oldest first. */
function span(from: number, count: number): LogEntry[] {
	return Array.from({ length: count }, (_, i) => logRecord(from + i));
}

const state = () => useLogsStore.getState();
const messages = () => state().records.map((r) => ("msg" in r ? r.msg : ""));

/** The record carrying its own line, as the reader delivers one. */
function withRawLine(record: LogFileRecord): LogFileRecord {
	return { ...record, $raw: JSON.stringify(record) };
}

/**
 * A log of numbered lines behind the fake bridge, one cursor offset per line:
 * a backward cursor at `n` continues with line `n - 1`, a forward one with
 * line `n`. A jump lands on lines `landed` to `landed + 999`.
 */
function numberedLog(landed: number): void {
	bridge.logs.read.mockImplementation(async (request: LogReadRequest) => {
		if (request.before) {
			const end = request.before.files[0].offset;
			return {
				records: span(end - request.limit, request.limit),
				cursor: logCursor(end - request.limit),
				more: true,
				scannedTo: null,
			};
		}
		if (request.after) {
			const start = request.after.files[0].offset;
			return {
				records: span(start, request.limit),
				cursor: logCursor(start + request.limit),
				more: true,
				scannedTo: null,
			};
		}
		return {
			records: span(landed, 1000),
			cursor: logCursor(landed),
			more: true,
			scannedTo: null,
			newer: logCursor(landed + 1000),
		};
	});
}

/** The held lines' numbers are one run with nothing missing. */
function expectNoMissingLine(): void {
	const numbers = messages().map((msg) => Number(msg.slice("line ".length)));
	const missing = numbers.filter((n, i) => i > 0 && n !== numbers[i - 1] + 1);
	expect(numbers.length).toBeGreaterThan(0);
	expect(missing).toEqual([]);
}

/**
 * Each file's held lines are one run: sorted by offset, each starts where the
 * one before it ended, so none is missing and none is held twice.
 */
function expectEachFileUnbroken(): Map<string, LogLinePosition[]> {
	const byFile = new Map<string, LogLinePosition[]>();
	for (const entry of state().records) {
		const position = entry.$pos as LogLinePosition;
		byFile.set(position.name, [...(byFile.get(position.name) ?? []), position]);
	}
	const breaks: string[] = [];
	for (const [name, positions] of byFile) {
		positions.sort((a, b) => a.start - b.start);
		positions.forEach((position, i) => {
			if (i > 0 && position.start !== positions[i - 1].end) {
				breaks.push(`${name} at ${position.start}`);
			}
		});
	}
	expect(byFile.size).toBeGreaterThan(0);
	expect(breaks).toEqual([]);
	return byFile;
}

/**
 * Lines spread over files as the reader delivers them: each file's lines in
 * order, ten bytes a line, `$pos` counted per file. `add` takes the line's
 * time as seconds into the fixtures' day; an unparsed line has none.
 */
function multiFileLog() {
	const lines: LogEntry[] = [];
	const nextStart = new Map<string, number>();
	const place = (file: { name: string; id: string }): LogLinePosition => {
		const start = nextStart.get(file.name) ?? 0;
		nextStart.set(file.name, start + 10);
		return { ...file, start, end: start + 10 };
	};
	return {
		lines,
		add(file: { name: string; id: string }, n: number, overrides: Partial<LogFileRecord> = {}) {
			const line = logRecord(n, {
				msg: `${file.name} ${n}`,
				$pos: place(file),
				...overrides,
			});
			lines.push(line);
			return line;
		},
		addUnparsed(file: { name: string; id: string }) {
			const line: LogEntry = { unparsed: true, raw: "SEGFAULT", $pos: place(file) };
			lines.push(line);
			return line;
		},
	};
}

const APP_LOG = { name: "app_20261118_100000.log", id: "1:3" };
const ROTATED_ENGINE_LOG = { name: "engine_20261118_090000.log", id: "1:1" };

beforeEach(() => {
	bridge = fakeLogsBridge();
	vi.stubGlobal("electronAPI", { logs: bridge.logs });
	useLogsStore.setState({
		controls: { minLevel: "debug", source: null, category: null, search: "" },
	});
});

afterEach(() => {
	state().stop();
	vi.unstubAllGlobals();
});

describe("start", () => {
	it("starts the tail, then reads the newest lines and follows", async () => {
		bridge.answer({ records: span(0, 3), more: true, scannedTo: logRecord(0).ts });

		await state().start();

		expect(bridge.logs.tailStart).toHaveBeenCalledWith({});
		expect(bridge.logs.read).toHaveBeenCalledWith({ filter: {}, limit: 1000 });
		// The tail first: a line written while the read answers must not fall between.
		expect(bridge.logs.tailStart.mock.invocationCallOrder[0]).toBeLessThan(
			bridge.logs.read.mock.invocationCallOrder[0]
		);
		expect(state()).toMatchObject({ status: "ready", follow: true, more: true });
		expect(state().records).toHaveLength(3);
	});

	it("keeps a line the tail delivered while the read was answering, once", async () => {
		const repeated = logRecord(2);
		const late = logRecord(3);
		bridge.logs.read.mockImplementation(async () => {
			// Delivered after the tail started and before the read returned: one
			// the read also holds, and one it does not.
			bridge.push([repeated, late]);
			return {
				records: [logRecord(1), repeated],
				cursor: { files: [] },
				more: false,
				scannedTo: null,
			};
		});

		await state().start();

		expect(state().records.map((r) => ("msg" in r ? r.msg : ""))).toEqual([
			"line 1",
			"line 2",
			"line 3",
		]);
	});

	it("does nothing without the bridge", async () => {
		vi.stubGlobal("electronAPI", undefined);

		await state().start();

		expect(state().status).toBe("idle");
		expect(bridge.logs.tailStart).not.toHaveBeenCalled();
	});

	it("reports a read that fails with what failed, and a reload recovers", async () => {
		bridge.logs.read.mockRejectedValueOnce(new Error("Refused: not the app window"));

		await state().start();

		expect(state()).toMatchObject({
			status: "error",
			error: "Couldn't read the logs - Refused: not the app window",
		});

		bridge.answer({ records: span(0, 2) });
		await state().reload();

		expect(state()).toMatchObject({ status: "ready", error: null });
		expect(state().records).toHaveLength(2);
	});
});

describe("the tail", () => {
	it("appends what main pushes and adds up what it dropped", async () => {
		bridge.answer({ records: span(0, 2) });
		await state().start();

		bridge.push(span(2, 2), 7);
		bridge.push(span(4, 1), 3);

		expect(state().records).toHaveLength(5);
		expect(state().dropped).toBe(10);
		expect(state().knownCategories).toEqual(["http"]);
	});

	it("ends on stop: the tail is stopped, unsubscribed, and a late batch is ignored", async () => {
		bridge.answer({ records: span(0, 2) });
		await state().start();
		expect(bridge.subscribers()).toBe(1);

		state().stop();

		expect(bridge.logs.tailStop).toHaveBeenCalledTimes(1);
		expect(bridge.subscribers()).toBe(0);
		expect(state().records).toEqual([]);

		bridge.push(span(5, 3));
		expect(state().records).toEqual([]);
	});

	it("drops a read that answers after stop", async () => {
		let release: (value: {
			records: LogEntry[];
			cursor: { files: [] };
			more: false;
			scannedTo: null;
		}) => void = () => {};
		bridge.logs.read.mockImplementation(
			() => new Promise((resolve) => (release = resolve as typeof release))
		);
		const started = state().start();
		await waitFor(() => expect(bridge.logs.read).toHaveBeenCalled());

		state().stop();
		release({ records: span(0, 3), cursor: { files: [] }, more: false, scannedTo: null });
		await started;

		expect(state().records).toEqual([]);
		expect(state().status).toBe("idle");
	});

	it("does not stop a tail it never started", () => {
		state().stop();
		expect(bridge.logs.tailStop).not.toHaveBeenCalled();
	});
});

describe("the bound", () => {
	it("holds LOG_MAX_RECORDS under a tail flood, newest kept", async () => {
		bridge.answer({ records: span(0, 1000) });
		await state().start();

		// 21 batches of the tail's 500: 1,000 + 10,500 = 11,500 lines offered.
		for (let batch = 0; batch < 21; batch++) bridge.push(span(1000 + batch * 500, 500));

		const { records } = state();
		expect(records).toHaveLength(LOG_MAX_RECORDS);
		expect((records[records.length - 1] as { msg: string }).msg).toBe("line 11499");
		expect((records[0] as { msg: string }).msg).toBe("line 1500");
	});

	it("holds LOG_MAX_BYTES, by the same estimate the response cache uses", async () => {
		const big = (n: number) => withRawLine(logRecord(n, { msg: "x".repeat(500_000) }));
		bridge.answer({ records: [big(0)] });
		await state().start();

		bridge.push([big(1), big(2), big(3), big(4), big(5), big(6), big(7), big(8)]);
		bridge.push([big(9), big(10), big(11), big(12), big(13), big(14), big(15), big(16)]);
		bridge.push([big(17), big(18), big(19)]);

		// Two bytes a UTF-16 unit, of the message once in the fields and once in the raw line.
		const each = entryBytes(big(20));
		expect(each).toBeGreaterThan(2 * 2 * 500_000);
		expect(state().bytes).toBeLessThanOrEqual(LOG_MAX_BYTES);
		expect(state().bytes).toBe(state().records.reduce((sum, r) => sum + entryBytes(r), 0));
		expect(state().records).toHaveLength(Math.floor(LOG_MAX_BYTES / each));
		expect((state().records[state().records.length - 1] as { msg: string }).msg).toBe(
			"x".repeat(500_000)
		);
	});

	it("counts an unparsed line as its raw text, and a record as itself serialised", () => {
		const record = logRecord(1);
		expect(entryBytes({ unparsed: true, raw: "SEGFAULT" })).toBe(2 * "SEGFAULT".length);
		expect(entryBytes(record)).toBe(2 * JSON.stringify(record).length);
		expect(entryBytes(withRawLine(record))).toBeGreaterThan(
			2 * 2 * JSON.stringify(record).length
		);
	});

	it("pages older from the oldest line held once following drops the oldest, none missing or repeated", async () => {
		numberedLog(5000);
		await state().start();
		const { cursor } = state();

		// 1,000 + 18 batches of 500 is the bound exactly; one line more drops line 5000.
		for (let batch = 0; batch < 18; batch++) bridge.push(span(6000 + batch * 500, 500));
		expect(state()).toMatchObject({ more: true, cursor });
		bridge.push(span(15_000, 1));

		expect(state()).toMatchObject({ more: true, cursor: logCursor(5001), scannedTo: null });
		await state().loadOlder();

		expect(bridge.logs.read).toHaveBeenLastCalledWith(
			expect.objectContaining({ before: logCursor(5001) })
		);
		expect(messages()[0]).toBe("line 4001");
		expectNoMissingLine();
	});

	it("reads the lines a burst left out again, once the bound drops the lines before them", async () => {
		numberedLog(5000);
		await state().start();
		// Lines 6000 to 6099 were left out of a burst, which the tail counts.
		bridge.push(span(6100, 500), 100);
		bridge.push(span(6600, 9500));

		expect(messages()[0]).toBe("line 6100");
		expect(state().cursor).toEqual(logCursor(6100));
		await state().loadOlder();

		expect(messages()[0]).toBe("line 5100");
		expectNoMissingLine();
	});

	it("pages older through files the tail interleaves, a lagging file and an unparsed line, none missing or repeated", async () => {
		const log = multiFileLog();
		// An older engine file a rotation renamed: nothing of it is held when the bound first cuts.
		for (let n = 0; n < 1000; n++) log.add(ROTATED_ENGINE_LOG, n);
		const tailFrom = (n: number) => (n % 3 === 0 ? APP_LOG : ENGINE_LOG);
		for (let n = 1000; n < 3000; n++) log.add(tailFrom(n), n);
		const readable = [...log.lines];
		const windows: LogEntry[][] = [];
		for (let n = 3000; n < 14_000; n++) {
			if (n % 300 === 0) windows.push([]);
			windows[windows.length - 1].push(log.add(tailFrom(n), n));
			if (n === 3100) windows[windows.length - 1].push(log.addUnparsed(ENGINE_LOG));
		}
		bridge.serveLog(readable);
		await state().start();
		expect(state().records).toHaveLength(1000);

		// The app file lags a poll: each batch carries its lines from the window before.
		const ofApp = (window: LogEntry[] = []) => window.filter((l) => l.$pos?.id === APP_LOG.id);
		const ofEngine = (window: LogEntry[]) => window.filter((l) => l.$pos?.id !== APP_LOG.id);
		windows.forEach((window, i) =>
			bridge.push([...ofApp(windows[i - 1]), ...ofEngine(window)])
		);
		bridge.push(ofApp(windows[windows.length - 1]));

		expect(state().records).toHaveLength(LOG_MAX_RECORDS);
		expect(state().more).toBe(true);
		expectEachFileUnbroken();
		bridge.serveLog(log.lines);
		for (let page = 0; page < 20 && state().more; page++) {
			await state().loadOlder();
			expectEachFileUnbroken();
		}

		expect(state().more).toBe(false);
		const files = expectEachFileUnbroken();
		expect([...files.keys()].sort()).toEqual(
			[APP_LOG.name, ENGINE_LOG.name, ROTATED_ENGINE_LOG.name].sort()
		);
		for (const positions of files.values()) expect(positions[0].start).toBe(0);
		expect(state().records).toContainEqual(expect.objectContaining({ unparsed: true }));
	});

	it("pages older through a file whose lines the byte bound dropped whole, from a read over the budget", async () => {
		const log = multiFileLog();
		const big = { msg: "x".repeat(1_000_000) };
		const rotated = [log.add(ROTATED_ENGINE_LOG, 0, big), log.add(ROTATED_ENGINE_LOG, 1, big)];
		for (let n = 2; n < 10; n++) log.add(ENGINE_LOG, n, big);
		// Two bytes a unit: eight of these fit in the 16 MiB, ten do not.
		expect(Math.floor(LOG_MAX_BYTES / entryBytes(log.lines[2]))).toBe(8);
		bridge.serveLog(log.lines);

		await state().start();

		expect(state().records).toEqual(log.lines.slice(2));
		expect(state()).toMatchObject({ more: true, scannedTo: null });
		await state().loadOlder();

		expect(state().records).toEqual([...rotated, ...log.lines.slice(2, 8)]);
		expect(state()).toMatchObject({ more: false, detached: true });
	});

	it("ends paging older when a trim cannot place a line: one that carries no position", async () => {
		numberedLog(5000);
		await state().start();
		bridge.push(span(6000, 9000));

		bridge.push([logRecord(15_000, { $pos: undefined })]);

		expect(state()).toMatchObject({ more: false, cursor: null });
		bridge.logs.read.mockClear();
		await state().loadOlder();
		expect(bridge.logs.read).not.toHaveBeenCalled();
	});

	it("keeps the newest line even when it alone is over the byte budget", async () => {
		const huge = logRecord(0, { msg: "x".repeat(LOG_MAX_BYTES) });
		bridge.answer({ records: [huge] });

		await state().start();

		expect(state().records).toEqual([huge]);
	});

	it("holds LOG_MAX_RECORDS under paging: the newest are dropped, follow is off and the tail detached", async () => {
		let older = 0;
		bridge.logs.read.mockImplementation(async (request: LogReadRequest) => {
			const page = request.before ? span(-1000 * ++older, 1000) : span(0, 1000);
			return {
				records: page,
				cursor: { files: [] },
				more: true,
				scannedTo: (page[0] as { ts: string }).ts,
			};
		});
		await state().start();

		// 1,000 held, then ten pages of 1,000 older: 11,000 offered.
		for (let page = 0; page < 10; page++) await state().loadOlder();

		const { records } = state();
		expect(records).toHaveLength(LOG_MAX_RECORDS);
		expect((records[0] as { msg: string }).msg).toBe("line -10000");
		// The newest 1,000 went: line 0 was in the first read and is the first lost.
		expect(records.some((r) => (r as { msg: string }).msg === "line 0")).toBe(false);
		expect(state()).toMatchObject({ follow: false, detached: true });

		bridge.push(span(5000, 4));
		expect(state().records).toHaveLength(LOG_MAX_RECORDS);
		expect(state().records.some((r) => (r as { msg: string }).msg === "line 5000")).toBe(false);
	});
});

describe("paging older", () => {
	it("prepends the page, turns follow off and keeps the tail attached while under the bound", async () => {
		bridge.answer({ records: span(10, 2), more: true, scannedTo: logRecord(10).ts });
		await state().start();
		const cursor = { files: [{ name: "engine_20261118_100000.log", id: "1", offset: 5 }] };
		bridge.answer({ records: span(0, 2), cursor, more: false, scannedTo: logRecord(0).ts });

		await state().loadOlder();

		expect(bridge.logs.read).toHaveBeenLastCalledWith({
			before: { files: [] },
			filter: {},
			limit: 1000,
		});
		expect(state().records.map((r) => (r as { msg: string }).msg)).toEqual([
			"line 0",
			"line 1",
			"line 10",
			"line 11",
		]);
		expect(state()).toMatchObject({
			follow: false,
			detached: false,
			more: false,
			cursor,
			scannedTo: logRecord(0).ts,
		});

		bridge.push(span(12, 1));
		expect(state().records).toHaveLength(5);
	});

	it("moves scannedTo even when the page held no line", async () => {
		bridge.answer({ records: span(10, 1), more: true, scannedTo: logRecord(10).ts });
		await state().start();
		bridge.answer({ records: [], more: true, scannedTo: logRecord(3).ts });

		await state().loadOlder();

		expect(state()).toMatchObject({ more: true, scannedTo: logRecord(3).ts });
		expect(state().records).toHaveLength(1);
	});

	it("asks nothing when there is nothing older", async () => {
		bridge.answer({ records: span(0, 1), more: false });
		await state().start();
		bridge.logs.read.mockClear();

		await state().loadOlder();

		expect(bridge.logs.read).not.toHaveBeenCalled();
	});

	it("reports a page that fails and keeps what is held", async () => {
		bridge.answer({ records: span(0, 1), more: true });
		await state().start();
		bridge.logs.read.mockRejectedValueOnce(new Error("disk went away"));

		await state().loadOlder();

		expect(state()).toMatchObject({
			status: "ready",
			loadingOlder: false,
			error: "Couldn't read the logs - disk went away",
		});
		expect(state().records).toHaveLength(1);
	});
});

describe("jump to time", () => {
	it("reads around the time, replaces the list, turns follow off and detaches the tail", async () => {
		bridge.answer({ records: span(0, 2), more: true });
		await state().start();
		bridge.answer({ records: span(100, 3), more: true });

		await state().jumpTo("2026-11-18T10:05:00.000Z");

		expect(bridge.logs.read).toHaveBeenLastCalledWith({
			around: "2026-11-18T10:05:00.000Z",
			filter: {},
			limit: 1000,
		});
		expect(state().records).toHaveLength(3);
		expect(state()).toMatchObject({ follow: false, detached: true });

		bridge.push(span(200, 2));
		expect(state().records).toHaveLength(3);
	});

	it("puts the lines after the time in the list: a page newer read at once from the cut", async () => {
		bridge.answer({ records: span(0, 2) });
		await state().start();
		const cut = logCursor(10);
		const further = logCursor(20);
		bridge.answerReads({
			around: { records: span(8, 2), more: true, newer: cut },
			after: {
				records: span(11, 2),
				more: true,
				cursor: further,
				scannedTo: logRecord(12).ts,
			},
		});
		bridge.logs.tailStart.mockClear();

		await state().jumpTo(logRecord(10).ts);

		expect(bridge.logs.read).toHaveBeenLastCalledWith({ after: cut, filter: {}, limit: 100 });
		expect(messages()).toEqual(["line 8", "line 9", "line 11", "line 12"]);
		expect(state()).toMatchObject({
			follow: false,
			detached: true,
			newerCursor: further,
			newerScannedTo: logRecord(12).ts,
			loadingNewer: false,
		});
		// The tail restarts before the page newer, in case that page reaches the end.
		expect(bridge.logs.tailStart.mock.invocationCallOrder[0]).toBeLessThan(
			bridge.logs.read.mock.invocationCallOrder[bridge.logs.read.mock.calls.length - 1]
		);
	});

	it("follows again by reading afresh, never by appending", async () => {
		bridge.answer({ records: span(0, 2) });
		await state().start();
		await state().jumpTo("2026-11-18T10:05:00.000Z");
		bridge.logs.tailStart.mockClear();
		bridge.answer({ records: span(300, 2) });

		state().setFollow(true);

		await waitFor(() => expect(state().detached).toBe(false));
		expect(bridge.logs.tailStart).toHaveBeenCalledTimes(1);
		expect(state()).toMatchObject({ follow: true });
		expect((state().records[0] as { msg: string }).msg).toBe("line 300");
	});
});

describe("paging newer", () => {
	/** Jump to a list holding lines 8 and 9, with a page newer that found nothing yet. */
	async function jumped(): Promise<void> {
		bridge.answer({ records: span(0, 2) });
		await state().start();
		bridge.answerReads({
			around: { records: span(8, 2), more: true, newer: logCursor(10) },
			after: { records: [], more: true, cursor: logCursor(11) },
		});
		await state().jumpTo(logRecord(10).ts);
	}

	it("appends the page and stays detached while there is more", async () => {
		await jumped();
		bridge.answerReads({ after: { records: span(10, 2), more: true, cursor: logCursor(12) } });

		await state().loadNewer();

		expect(bridge.logs.read).toHaveBeenLastCalledWith({
			after: logCursor(11),
			filter: {},
			limit: 1000,
		});
		expect(messages()).toEqual(["line 8", "line 9", "line 10", "line 11"]);
		expect(state()).toMatchObject({ detached: true, newerCursor: logCursor(12) });
		bridge.push(span(50, 1));
		expect(state().records).toHaveLength(4);
	});

	it("attaches the tail at the end of the logs, keeping a line it delivered during the page once", async () => {
		await jumped();
		const repeated = logRecord(11);
		bridge.logs.read.mockImplementation(async () => {
			// Delivered after the tail restarted and before the page returned.
			bridge.push([repeated, logRecord(12)]);
			return {
				records: [logRecord(10), repeated],
				cursor: logCursor(13),
				more: false,
				scannedTo: null,
			};
		});

		await state().loadNewer();

		expect(messages()).toEqual(["line 8", "line 9", "line 10", "line 11", "line 12"]);
		expect(state()).toMatchObject({ detached: false, follow: false, newerCursor: null });
		bridge.push(span(13, 1));
		expect(messages()).toEqual([
			"line 8",
			"line 9",
			"line 10",
			"line 11",
			"line 12",
			"line 13",
		]);
	});

	it("pages older from the oldest line held once Search newer drops the oldest, none missing or repeated", async () => {
		bridge.answer({ records: span(0, 2) });
		await state().start();
		numberedLog(9000);
		await state().jumpTo(logRecord(9500).ts);

		// 1,000 landed, 100 read at once and ten pages of 1,000: 1,100 over the bound.
		for (let page = 0; page < 10; page++) await state().loadNewer();
		expect(state().records).toHaveLength(LOG_MAX_RECORDS);
		expect(state()).toMatchObject({ more: true, cursor: logCursor(10_100) });
		await state().loadOlder();

		expect(bridge.logs.read).toHaveBeenLastCalledWith(
			expect.objectContaining({ before: logCursor(10_100) })
		);
		expect(messages()[0]).toBe("line 9100");
		expectNoMissingLine();
	});

	it("discards a page older still in flight when a page newer drops the oldest, then pages from the oldest held", async () => {
		bridge.answer({ records: span(0, 2) });
		await state().start();
		numberedLog(9000);
		await state().jumpTo(logRecord(9500).ts);
		for (let page = 0; page < 8; page++) await state().loadNewer();
		let release: (value: LogReadResult) => void = () => {};
		bridge.logs.read.mockImplementationOnce(
			() => new Promise((resolve) => (release = resolve))
		);
		const paging = state().loadOlder();
		await waitFor(() =>
			expect(bridge.logs.read).toHaveBeenLastCalledWith(
				expect.objectContaining({ before: logCursor(9000) })
			)
		);
		for (let page = 0; page < 2; page++) await state().loadNewer();
		expect(state().cursor).toEqual(logCursor(10_100));

		release({
			records: span(8000, 1000),
			cursor: logCursor(8000),
			more: true,
			scannedTo: null,
		});
		await paging;

		expect(state()).toMatchObject({ loadingOlder: false, cursor: logCursor(10_100) });
		expect(messages()[0]).toBe("line 10100");
		expectNoMissingLine();
		await state().loadOlder();
		expect(messages()[0]).toBe("line 9100");
		expectNoMissingLine();
	});

	it("drops the oldest at the bound, as following does", async () => {
		await jumped();
		let newer = 0;
		bridge.logs.read.mockImplementation(async () => {
			const page = span(100 + 1000 * newer++, 1000);
			return { records: page, cursor: logCursor(newer), more: true, scannedTo: null };
		});

		for (let page = 0; page < 10; page++) await state().loadNewer();

		const { records } = state();
		expect(records).toHaveLength(LOG_MAX_RECORDS);
		expect((records[records.length - 1] as { msg: string }).msg).toBe("line 10099");
		expect(records.some((r) => (r as { msg: string }).msg === "line 8")).toBe(false);
		expect(state()).toMatchObject({ detached: true, newerCursor: logCursor(10) });
	});

	it("holds once a line the read returned that the tail delivers after it, on attaching", async () => {
		await jumped();
		bridge.answerReads({ after: { records: span(10, 3), more: false, cursor: logCursor(13) } });

		await state().loadNewer();
		// Written after the tail restarted and before the page read the file's end,
		// delivered by the tail's first poll after the page answered.
		bridge.push(span(11, 3));
		bridge.push(span(14, 1));

		expect(messages()).toEqual([
			"line 8",
			"line 9",
			"line 10",
			"line 11",
			"line 12",
			"line 13",
			"line 14",
		]);
	});

	it("ends the overlap with the first batch that repeats nothing", async () => {
		bridge.answer({ records: span(0, 3) });
		await state().start();

		bridge.push(span(2, 2));
		bridge.push(span(4, 1));
		// A line the read held, written again: past the overlap it is a line of its own.
		bridge.push([logRecord(1)]);

		expect(messages()).toEqual(["line 0", "line 1", "line 2", "line 3", "line 4", "line 1"]);
	});

	it("ends when paging older drops the newest lines, and drops a page newer still in flight", async () => {
		await jumped();
		let release: (value: LogReadResult) => void = () => {};
		bridge.logs.read.mockImplementationOnce(
			() => new Promise((resolve) => (release = resolve))
		);
		const paging = state().loadNewer();
		await waitFor(() => expect(state().loadingNewer).toBe(true));
		await waitFor(() =>
			expect(bridge.logs.read).toHaveBeenLastCalledWith(
				expect.objectContaining({ after: logCursor(11) })
			)
		);
		let older = 0;
		bridge.logs.read.mockImplementation(async () => ({
			records: span(-1000 * ++older, 1000),
			cursor: { files: [] },
			more: true,
			scannedTo: null,
		}));
		for (let page = 0; page < 10; page++) await state().loadOlder();
		expect(state()).toMatchObject({ detached: true, newerCursor: null });

		release({ records: span(10, 5), cursor: logCursor(15), more: false, scannedTo: null });
		await paging;

		expect(state()).toMatchObject({ detached: true, newerCursor: null, loadingNewer: false });
		expect(state().records.some((r) => (r as { msg: string }).msg === "line 10")).toBe(false);
	});

	it("asks nothing when there is no page newer", async () => {
		bridge.answer({ records: span(0, 1) });
		await state().start();
		bridge.logs.read.mockClear();

		await state().loadNewer();

		expect(bridge.logs.read).not.toHaveBeenCalled();
	});

	it("reports a page that fails and keeps what is held", async () => {
		await jumped();
		bridge.logs.read.mockRejectedValueOnce(new Error("disk went away"));

		await state().loadNewer();

		expect(state()).toMatchObject({
			status: "ready",
			loadingNewer: false,
			newerCursor: logCursor(11),
			error: "Couldn't read the logs - disk went away",
		});
		expect(state().records).toHaveLength(2);
	});
});

describe("follow", () => {
	it("is on by default and set directly while attached", async () => {
		bridge.answer({ records: span(0, 1) });
		await state().start();
		expect(state().follow).toBe(true);

		state().setFollow(false);
		expect(state().follow).toBe(false);

		state().setFollow(true);
		expect(state().follow).toBe(true);
		expect(bridge.logs.tailStart).toHaveBeenCalledTimes(1);
	});
});

describe("filters", () => {
	it("re-issues the read and restarts the tail with the new filter, replacing what was held", async () => {
		bridge.answer({ records: span(0, 5) });
		await state().start();
		bridge.logs.read.mockClear();
		bridge.logs.tailStart.mockClear();
		bridge.answer({ records: [logRecord(50, { level: "error" })] });

		state().setControls({ minLevel: "error", source: "engine", category: "oauth" });

		await waitFor(() => expect(state().records).toHaveLength(1));
		const filter = { minLevel: "error", sources: ["engine"], categories: ["oauth"] };
		expect(bridge.logs.tailStart).toHaveBeenCalledWith(filter);
		expect(bridge.logs.read).toHaveBeenCalledWith({ filter, limit: 1000 });
	});

	it("sends cat:oauth as a term, not as the component filter", async () => {
		bridge.answer({ records: span(0, 1) });
		await state().start();
		bridge.logs.tailStart.mockClear();

		state().setControls({ search: `token cat:oauth runId:"a b"` });

		await waitFor(() => expect(bridge.logs.tailStart).toHaveBeenCalled());
		expect(bridge.logs.tailStart).toHaveBeenCalledWith({
			text: "token",
			terms: [
				{ field: "cat", value: "oauth", exact: false },
				{ field: "runId", value: "a b", exact: true },
			],
		});
	});

	it("does not re-issue when the controls change but the filter does not", async () => {
		bridge.answer({ records: span(0, 1) });
		await state().start();
		bridge.logs.tailStart.mockClear();

		state().setControls({ search: "   " });

		expect(state().controls.search).toBe("   ");
		expect(bridge.logs.tailStart).not.toHaveBeenCalled();
	});

	it("drops a page still in flight when the filter changes under it", async () => {
		bridge.answer({ records: span(0, 1), more: true });
		await state().start();
		let release: (value: {
			records: LogEntry[];
			cursor: { files: [] };
			more: false;
			scannedTo: null;
		}) => void = () => {};
		bridge.logs.read.mockImplementationOnce(
			() => new Promise((resolve) => (release = resolve as typeof release))
		);
		const paging = state().loadOlder();
		await waitFor(() => expect(bridge.logs.read).toHaveBeenCalledTimes(2));
		bridge.answer({ records: [logRecord(70)] });

		state().setControls({ minLevel: "warn" });
		await waitFor(() => expect(state().records).toHaveLength(1));
		release({ records: span(0, 9), cursor: { files: [] }, more: false, scannedTo: null });
		await paging;

		expect(state().records).toHaveLength(1);
		expect((state().records[0] as { msg: string }).msg).toBe("line 70");
	});

	it("keeps what it holds until it is started: a control change before mount reads nothing", () => {
		state().setControls({ minLevel: "warn" });

		expect(state().controls.minLevel).toBe("warn");
		expect(bridge.logs.tailStart).not.toHaveBeenCalled();
	});
});

describe("buildLogFilter", () => {
	it("leaves out what constrains nothing", () => {
		expect(
			buildLogFilter({ minLevel: "debug", source: null, category: null, search: "" })
		).toEqual({});
	});

	it("carries each control into its own key", () => {
		expect(
			buildLogFilter({
				minLevel: "warn",
				source: "app",
				category: "ipc",
				search: "boom status:500",
			})
		).toEqual({
			minLevel: "warn",
			sources: ["app"],
			categories: ["ipc"],
			text: "boom",
			terms: [{ field: "status", value: "500", exact: false }],
		});
	});
});
