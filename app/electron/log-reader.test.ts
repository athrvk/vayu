/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Logs tab's main-process reader (#3635), against a temp directory: the
 * app's lines written by the real `createLogger`, the engine's from a fixture
 * held to `docs/engine/log-record.schema.json`.
 *
 * The tail's poll is driven by injected timers rather than `vi.useFakeTimers`:
 * a poll does real file I/O, which advancing a fake clock does not wait for.
 * `manualTimers().poll()` fires the scheduled poll and resolves when the poll
 * schedules its successor, which is the moment it has finished.
 *
 * Mutation checks: carry no bytes across a chunk boundary in `BackwardLines`
 * and the paging cases lose or garble records; deliver `ForwardLines`' held
 * bytes as a line and the half-written case receives an unparsed line; drop
 * the name check in `checkCursor` and the traversal cases stop refusing; leave
 * the offset where it was in `mergeOldestFirst` and the forward paging cases
 * repeat records (or never end); cut `newer` at the file's end and the jump
 * case loses t+1; drop the `unopened` entries from `readForward`'s cursor and
 * the rotation-between-listing-and-open case reads the renamed file twice;
 * return `null` from `openFollowingRename` where the open misses and the
 * backward rotation-between-listing-and-open cases lose the renamed file.
 *
 * Every read and tail case checks each line's `$pos` against the file
 * (`expectAtItsPosition`), and the position cases pin the numbers (#3652):
 * end every backward line one past its length and the unterminated cases red;
 * leave `ForwardLines`' line start where it was and the forward cases red; end
 * its flushed line one byte late and the unterminated case reds; start a
 * tailed file's splitter at 0 and the tail cases red; search `$pos` as text
 * and the free-text case matches the file name; attach an empty `id` and
 * every read case reds.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs, {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { createLogger } from "./log";
import {
	LOG_READ_LIMIT_MAX,
	LOG_SCAN_BUDGET_BYTES,
	LOG_TAIL_BATCH_MAX,
	LOG_TAIL_POLL_MS,
	RECORD_MAX_BYTES,
	UNPARSED_RAW_MAX_BYTES,
	compileLogFilter,
	POSITION_KEY,
	RAW_LINE_KEY,
	createLogTail,
	isUnparsedLine,
	listLogFiles,
	parseSearchInput,
	readLogs as readLogsWithRaw,
	type LogBatch,
	type LogEntry,
	type LogFileRecord,
	type LogFilter,
	type LogLinePosition,
	type LogReaderDeps,
	type LogTailTimers,
	type ReadLogsOptions,
} from "./log-reader";

const schema = JSON.parse(
	readFileSync(fromRepoRoot("docs/engine/log-record.schema.json"), "utf8")
) as {
	required: string[];
	propertyNames: { pattern: string };
	properties: { ts: { pattern: string }; level: { enum: string[] }; src: { enum: string[] } };
	oneOf: { properties: { src: { const: string }; cat: { enum: string[] } } }[];
};

/** The temp root; the logs directory is inside it, so "outside the logs" is still ours. */
let root: string;
let dir: string;
let deps: LogReaderDeps;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "vayu-log-reader-"));
	dir = path.join(root, "logs");
	mkdirSync(dir);
	deps = { fs: fs.promises, logsDir: dir };
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const BASE_MS = Date.parse("2026-11-18T10:00:00.000Z");
const tsAt = (second: number) => new Date(BASE_MS + second * 1000).toISOString();

/** Keys sorted, as nlohmann's default object serialises them (`logger.cpp`). */
function sortedKeys(record: Record<string, unknown>): LogFileRecord {
	return Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1))
	) as LogFileRecord;
}

function engineRecord(
	second: number,
	cat: string,
	msg: string,
	fields: Record<string, unknown> = {},
	level = "info",
	src = "engine"
): LogFileRecord {
	return sortedKeys({
		ts: tsAt(second),
		level,
		src,
		cat,
		msg,
		pid: 4242,
		tid: "140001",
		...fields,
	});
}

const line = (record: object) => JSON.stringify(record) + "\n";

/** The identity the reader gives the file at @p name, spelled as `LogCursorFile.id` is. */
function fileId(name: string): string {
	const stats = fs.statSync(path.join(dir, name), { bigint: true });
	return stats.ino === 0n ? "" : `${stats.dev}:${stats.ino}`;
}

/**
 * Check that @p entry's position names the bytes it was decoded from, in the
 * file as it is now: from just after a newline (or the file's start) to just
 * after the next one (or the file's end), holding the text the entry carries.
 */
function expectAtItsPosition(entry: LogEntry): void {
	const position = entry[POSITION_KEY];
	if (!position) throw new Error("A delivered line carries no position");
	const { name, id, start, end } = position;
	expect(id).toBe(fileId(name));
	const fd = fs.openSync(path.join(dir, name), "r");
	try {
		const from = Math.max(0, start - 1);
		const bytes = Buffer.alloc(end - from);
		expect(fs.readSync(fd, bytes, 0, bytes.length, from)).toBe(bytes.length);
		if (start > 0) expect(bytes[0]).toBe(0x0a);
		const held = bytes.subarray(start - from);
		const newline = held.indexOf(0x0a);
		if (newline === -1) expect(end).toBe(fs.fstatSync(fd).size);
		else expect(newline).toBe(held.length - 1);
		const text = held.toString("utf8").replace(/\r?\n$/, "");
		const carried = isUnparsedLine(entry) ? entry.raw : (entry as LogFileRecord)[RAW_LINE_KEY];
		const bound = isUnparsedLine(entry) ? UNPARSED_RAW_MAX_BYTES : RECORD_MAX_BYTES;
		expect(typeof carried).toBe("string");
		if (Buffer.byteLength(text) <= bound) expect(carried).toBe(text);
		else expect(text.startsWith(carried as string)).toBe(true);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * @p entry, its position checked, without the keys the reader adds, so it
 * compares against its fixture.
 */
function asFixture<T extends LogEntry>(entry: T): T {
	expectAtItsPosition(entry);
	if (isUnparsedLine(entry)) {
		const { [POSITION_KEY]: _position, ...rest } = entry;
		return rest as T;
	}
	const { [RAW_LINE_KEY]: _raw, [POSITION_KEY]: _position, ...fields } = entry as LogFileRecord;
	return fields as T;
}

/**
 * `readLogs` with every position checked and the reader's keys stripped; the
 * raw-line and position cases call `readLogsWithRaw`.
 */
const readLogs: typeof readLogsWithRaw = async (readerDeps, options) => {
	const result = await readLogsWithRaw(readerDeps, options);
	return { ...result, records: result.records.map(asFixture) };
};

function writeLog(name: string, records: object[], eol = "\n"): void {
	writeFileSync(
		path.join(dir, name),
		records.map((record) => JSON.stringify(record) + eol).join("")
	);
}

/** Engine lines as the daemon writes them: one per category the viewer cares about. */
const ENGINE_FIXTURE: LogFileRecord[] = [
	engineRecord(0, "startup", "Vayu engine starting", { version: "0.42.0", port: 9876 }),
	engineRecord(1, "http", "Request answered", {
		method: "GET",
		path: "/health",
		status: 200,
		durationMs: 1.5,
	}),
	engineRecord(
		2,
		"oauth",
		"Token request failed",
		{ status: 500, tokenUrl: "https://auth.example/token", runId: "run-abc" },
		"warn"
	),
	engineRecord(
		3,
		"client",
		"curl exchange",
		{ lines: ["> GET / HTTP/1.1", "< HTTP/1.1 200 OK"] },
		"debug"
	),
	engineRecord(
		4,
		"db",
		"Write failed",
		{ err: { name: "SqliteError", message: "disk I/O error" } },
		"error"
	),
	engineRecord(5, "script", "héllo ✓ 日本語 🚀", { req: "c0ffee" }),
];

function schemaViolations(record: Record<string, unknown>): string[] {
	const problems: string[] = [];
	for (const key of schema.required) if (!(key in record)) problems.push(`missing ${key}`);
	const keyPattern = new RegExp(schema.propertyNames.pattern);
	for (const key of Object.keys(record)) if (!keyPattern.test(key)) problems.push(`key ${key}`);
	if (!new RegExp(schema.properties.ts.pattern).test(String(record.ts))) problems.push("ts");
	if (!schema.properties.level.enum.includes(String(record.level))) problems.push("level");
	if (!schema.properties.src.enum.includes(String(record.src))) problems.push("src");
	const branch = schema.oneOf.find((b) => b.properties.src.const === record.src);
	if (!branch?.properties.cat.enum.includes(String(record.cat))) problems.push("cat");
	if (!Number.isInteger(record.pid)) problems.push("pid");
	if (typeof record.msg !== "string") problems.push("msg");
	return problems;
}

/** Page through everything with @p options' filter, oldest first. */
async function readAll(
	readerDeps: LogReaderDeps,
	options: Omit<ReadLogsOptions, "before" | "around">
): Promise<LogEntry[]> {
	const pages: LogEntry[][] = [];
	let result = await readLogs(readerDeps, options);
	pages.push(result.records);
	while (result.more) {
		result = await readLogs(readerDeps, { ...options, before: result.cursor });
		pages.push(result.records);
	}
	return pages.reverse().flat();
}

describe("listLogFiles", () => {
	it("lists the log files by name, source, size and modified time, and nothing else", async () => {
		writeLog("engine_20261118_100000.log", [ENGINE_FIXTURE[0]]);
		writeLog("engine_20261118_100000.log.1", [ENGINE_FIXTURE[1]]);
		writeLog("app_20261118_090000.log", [ENGINE_FIXTURE[2]]);
		writeLog("cli_20261118_110000.log", []);
		writeLog("mcp_20261118_110000.log", []);
		for (const stray of [
			"notes.log",
			"engine.log",
			"engine_20261118_100000.log.2",
			"web_20261118_100000.log",
		]) {
			writeFileSync(path.join(dir, stray), "{}\n");
		}
		mkdirSync(path.join(dir, "engine_20261118_120000.log"));

		const files = await listLogFiles(deps);

		expect(files.map((file) => [file.name, file.source])).toEqual([
			["app_20261118_090000.log", "app"],
			["cli_20261118_110000.log", "cli"],
			["engine_20261118_100000.log", "engine"],
			["engine_20261118_100000.log.1", "engine"],
			["mcp_20261118_110000.log", "mcp"],
		]);
		expect(files[2].size).toBe(Buffer.byteLength(line(ENGINE_FIXTURE[0])));
		expect(files[2].mtimeMs).toBeGreaterThan(0);
	});

	it("answers an empty list when the logs directory does not exist yet", async () => {
		expect(await listLogFiles({ ...deps, logsDir: path.join(root, "absent") })).toEqual([]);
	});
});

describe("readLogs - records", () => {
	it("every engine fixture line is a record the schema accepts", () => {
		expect(ENGINE_FIXTURE.length).toBeGreaterThan(0);
		for (const record of ENGINE_FIXTURE) expect(schemaViolations(record)).toEqual([]);
	});

	it("reads the engine's lines back with every key, CRLF line ends included", async () => {
		writeLog("engine_20261118_100000.log", ENGINE_FIXTURE, "\r\n");

		const result = await readLogs(deps, { filter: {}, limit: 100 });

		expect(result.records).toEqual(ENGINE_FIXTURE);
		expect(result.more).toBe(false);
	});

	it("reads what the real app logger wrote with every key", async () => {
		let clock = BASE_MS;
		const options = {
			logsDir: dir,
			consoleEnabled: false,
			now: () => new Date(clock),
			pid: 777,
		};
		const app = createLogger("app", options);
		const mcp = createLogger("mcp", options);
		app.applyFloor("debug");
		clock = BASE_MS + 1000;
		app.info("sidecar", "Engine started successfully", { port: 9876 });
		clock = BASE_MS + 2000;
		mcp.warn("mcp", "Tool call cut", { tool: "send_request" });

		const { records } = await readLogs(deps, { filter: {}, limit: 10 });

		expect(records).toEqual([
			{
				ts: tsAt(1),
				level: "info",
				src: "app",
				cat: "sidecar",
				msg: "Engine started successfully",
				pid: 777,
				port: 9876,
			},
			{
				ts: tsAt(2),
				level: "warn",
				src: "mcp",
				cat: "mcp",
				msg: "Tool call cut",
				pid: 777,
				tool: "send_request",
			},
		]);
		for (const record of records as LogFileRecord[])
			expect(schemaViolations(record)).toEqual([]);
	});

	it("answers a line that is not a record as unparsed, its raw text cut at 8 KiB on a character boundary", async () => {
		const longLine = "é".repeat(10_000);
		const missingTs = JSON.stringify({
			level: "info",
			src: "engine",
			cat: "http",
			msg: "no time",
			pid: 1,
		});
		writeFileSync(
			path.join(dir, "engine_20261118_100000.log"),
			line(ENGINE_FIXTURE[0]) +
				"not json at all\n" +
				missingTs +
				"\n" +
				longLine +
				"\n" +
				line(ENGINE_FIXTURE[1])
		);

		const { records } = await readLogs(deps, { filter: {}, limit: 10 });

		expect(records.slice(1, 4)).toEqual([
			{ unparsed: true, raw: "not json at all" },
			{ unparsed: true, raw: missingTs },
			{ unparsed: true, raw: "é".repeat(UNPARSED_RAW_MAX_BYTES / 2) },
		]);
		expect(records[0]).toEqual(ENGINE_FIXTURE[0]);
		expect(records[4]).toEqual(ENGINE_FIXTURE[1]);
	});

	it("cuts the largest fields of a record over 256 KiB with the marker, and keeps the rest", async () => {
		const big = engineRecord(0, "client", "curl exchange", {
			body: "x".repeat(RECORD_MAX_BYTES),
			small: "keep me",
		});
		writeLog("engine_20261118_100000.log", [big]);

		const [record] = (await readLogs(deps, { filter: {}, limit: 1 }))
			.records as LogFileRecord[];

		expect(record.body).toBe("x".repeat(1024) + "...[truncated]");
		expect({ ...record, body: big.body }).toEqual(big);
		expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(RECORD_MAX_BYTES);
	});

	describe("the raw line", () => {
		/** Not what `JSON.stringify` writes: `1.0` and a space after a colon survive only as text. */
		const RAW_TEXT =
			'{"ts":"2026-11-18T10:00:00.000Z","level":"info","src":"engine","cat":"http","msg":"ok","pid":1,"x":1.0, "y":"\\u00e9"}';

		it("comes back with each record, byte for byte as the file holds it", async () => {
			writeFileSync(path.join(dir, "engine_20261118_100000.log"), RAW_TEXT + "\r\n");

			const [record] = (await readLogsWithRaw(deps, { filter: {}, limit: 1 }))
				.records as LogFileRecord[];

			expect(record[RAW_LINE_KEY]).toBe(RAW_TEXT);
			expect(record.x).toBe(1);
		});

		it("comes back with each record the tail delivers", async () => {
			writeFileSync(path.join(dir, "engine_20261118_100000.log"), "");
			const clock = manualTimers();
			const batches: LogBatch[] = [];
			const tail = await createLogTail(
				{ ...deps, timers: clock.timers },
				{ filter: {}, onBatch: (batch) => batches.push(batch) }
			);

			appendFileSync(path.join(dir, "engine_20261118_100000.log"), RAW_TEXT + "\n");
			await clock.poll();

			expect((batches[0].records[0] as LogFileRecord)[RAW_LINE_KEY]).toBe(RAW_TEXT);
			tail.stop();
		});

		it("is the line cut at the record bound for a record that had fields cut", async () => {
			const big = engineRecord(0, "client", "curl exchange", {
				body: "x".repeat(2 * RECORD_MAX_BYTES),
			});
			writeLog("engine_20261118_100000.log", [big]);

			const [record] = (await readLogsWithRaw(deps, { filter: {}, limit: 1 }))
				.records as LogFileRecord[];

			expect(record[RAW_LINE_KEY]).toBe(JSON.stringify(big).slice(0, RECORD_MAX_BYTES));
		});

		it("is not searched by free text, which matches field values only", async () => {
			writeFileSync(path.join(dir, "engine_20261118_100000.log"), RAW_TEXT + "\n");

			const byKeyName = await readLogsWithRaw(deps, { filter: { text: "level" }, limit: 5 });
			const byValue = await readLogsWithRaw(deps, { filter: { text: "ok" }, limit: 5 });

			expect(byKeyName.records).toEqual([]);
			expect(byValue.records).toHaveLength(1);
		});
	});

	it("answers a line past the parse ceiling as unparsed, from its first byte", async () => {
		const giant = engineRecord(1, "client", "huge", { body: "y".repeat(17 * 1024 * 1024) });
		writeLog("engine_20261118_100000.log", [ENGINE_FIXTURE[0], giant, ENGINE_FIXTURE[2]]);

		// The giant line is past the scan budget on its own, so it takes more than one page.
		const records = await readAll(deps, { filter: {}, limit: 10 });

		expect(records).toHaveLength(3);
		expect(records[0]).toEqual(ENGINE_FIXTURE[0]);
		expect(records[2]).toEqual(ENGINE_FIXTURE[2]);
		const raw = (records[1] as { raw: string }).raw;
		expect(isUnparsedLine(records[1])).toBe(true);
		expect(raw).toBe(JSON.stringify(giant).slice(0, UNPARSED_RAW_MAX_BYTES));
	});
});

describe("readLogs - backward paging", () => {
	/**
	 * Three sources and a rotated generation, interleaved by second. The app's
	 * file name is stamped in UTC and the engine's in local time, so the names
	 * here deliberately do not sort the way the records do.
	 */
	function writeInterleaved(): LogFileRecord[] {
		const engineOld: LogFileRecord[] = [];
		const engineNew: LogFileRecord[] = [];
		const app: LogFileRecord[] = [];
		const cli: LogFileRecord[] = [];
		for (let second = 0; second < 60; second++) {
			const msg = second % 4 === 0 ? `héllo ${second} ✓ 日本語 🚀` : `record ${second}`;
			if (second % 3 === 0)
				(second < 30 ? engineOld : engineNew).push(engineRecord(second, "http", msg));
			else if (second % 3 === 1)
				app.push(engineRecord(second, "sidecar", msg, {}, "info", "app"));
			else cli.push(engineRecord(second, "cli", msg, {}, "info", "cli"));
		}
		writeLog("engine_20261118_110000.log.1", engineOld);
		writeLog("engine_20261118_110000.log", engineNew);
		writeLog("app_20261118_100000.log", app);
		writeLog("cli_20261118_090000.log", cli);
		return [...engineOld, ...engineNew, ...app, ...cli].sort((a, b) => (a.ts < b.ts ? -1 : 1));
	}

	it.each([1, 2, 3, 7, 64, 100, 65536])(
		"returns every record once, in ts order, across files and pages (chunk %i bytes)",
		async (chunkBytes) => {
			const expected = writeInterleaved();

			const records = await readAll({ ...deps, chunkBytes }, { filter: {}, limit: 7 });

			expect(records.map((record) => (record as LogFileRecord).ts)).toEqual(
				expected.map((record) => record.ts)
			);
			expect(records).toEqual(expected);
		}
	);

	it("decodes a multi-byte character split by a chunk boundary", async () => {
		const earlier = engineRecord(0, "script", "earlier");
		// The emoji near the line's start and a long field after it, so one chunk
		// holds the emoji's tail to the line's end and the next reaches back past
		// the line's start: the character is split between a line's two pieces.
		const record = engineRecord(1, "script", "🚀 after", { zpad: "p".repeat(300) });
		writeLog("engine_20261118_100000.log", [earlier, record]);
		const text = line(earlier) + line(record);
		const lineStart = Buffer.byteLength(line(earlier));
		const emojiAt = Buffer.byteLength(text.slice(0, text.indexOf("🚀")));
		const chunkBytes = Buffer.byteLength(text) - (emojiAt + 2);
		expect(chunkBytes).toBeGreaterThan(emojiAt + 2 - lineStart);

		const { records } = await readLogs({ ...deps, chunkBytes }, { filter: {}, limit: 2 });

		expect(records).toEqual([earlier, record]);
	});

	it("holds back a last line with no newline in a source's newest file, not in an older one", async () => {
		const partial = JSON.stringify(ENGINE_FIXTURE[3]).slice(0, 30);
		writeFileSync(
			path.join(dir, "engine_20261118_100000.log"),
			line(ENGINE_FIXTURE[0]) + partial
		);
		writeFileSync(
			path.join(dir, "engine_20261118_110000.log"),
			line(ENGINE_FIXTURE[1]) + partial
		);

		const { records } = await readLogs(deps, { filter: {}, limit: 10 });

		expect(records).toEqual([
			ENGINE_FIXTURE[0],
			ENGINE_FIXTURE[1],
			{ unparsed: true, raw: partial },
		]);
	});

	it("continues on the renamed file after a rotation between pages, and never reads the fresh one", async () => {
		const name = "engine_20261118_100000.log";
		const first = Array.from({ length: 10 }, (_, second) =>
			engineRecord(second, "http", `r${second}`)
		);
		writeLog(name, first);
		const page1 = await readLogs(deps, { filter: {}, limit: 4 });
		renameSync(path.join(dir, name), path.join(dir, `${name}.1`));
		writeLog(name, [engineRecord(10, "http", "after rotation")]);

		const page2 = await readLogs(deps, { filter: {}, limit: 4, before: page1.cursor });
		const page3 = await readLogs(deps, { filter: {}, limit: 4, before: page2.cursor });

		expect(page1.records).toEqual(first.slice(6));
		expect(page2.records).toEqual(first.slice(2, 6));
		expect(page3.records).toEqual(first.slice(0, 2));
		expect(page3.more).toBe(false);
	});

	describe("a file rotated between the listing and the open", () => {
		const name = "engine_20261118_100000.log";
		const first = Array.from({ length: 10 }, (_, second) =>
			engineRecord(second, "http", `r${second}`)
		);
		const fresh = [engineRecord(10, "http", "after rotation")];

		/**
		 * `fs.promises` that rotates the file on the next open once armed: the
		 * listing saw it under its name, and by the open it is `.1`.
		 */
		function rotatingOnOpen() {
			let armed = false;
			const rotatingFs: LogReaderDeps["fs"] = {
				readdir: (target) => fs.promises.readdir(target),
				lstat: (target, options) => fs.promises.lstat(target, options),
				open: async (target, flags) => {
					if (armed) {
						armed = false;
						renameSync(path.join(dir, name), path.join(dir, `${name}.1`));
						writeLog(name, fresh);
					}
					return fs.promises.open(target, flags);
				},
			};
			return { deps: { ...deps, fs: rotatingFs }, arm: () => (armed = true) };
		}

		it("is read under its new name by the newest read, and the fresh file is left to the tail", async () => {
			writeLog(name, first);
			const rotating = rotatingOnOpen();

			rotating.arm();
			const records = await readAll(rotating.deps, { filter: {}, limit: 4 });

			expect(records).toEqual(first);
		});

		it("is read under its new name by a page older", async () => {
			writeLog(name, first);
			const rotating = rotatingOnOpen();
			const page1 = await readLogs(rotating.deps, { filter: {}, limit: 4 });

			rotating.arm();
			const page2 = await readLogs(rotating.deps, {
				filter: {},
				limit: 4,
				before: page1.cursor,
			});
			const page3 = await readLogs(rotating.deps, {
				filter: {},
				limit: 4,
				before: page2.cursor,
			});

			expect(page1.records).toEqual(first.slice(6));
			expect(page2.records).toEqual(first.slice(2, 6));
			expect(page3.records).toEqual(first.slice(0, 2));
			expect(page3.more).toBe(false);
		});

		it("is cut at the time by a jump, in both its cursors", async () => {
			writeLog(name, first);
			const rotating = rotatingOnOpen();

			rotating.arm();
			const landed = await readLogs(rotating.deps, { filter: {}, limit: 4, around: tsAt(5) });
			const older = await readLogs(rotating.deps, {
				filter: {},
				limit: 4,
				before: landed.cursor,
			});
			const newer = await readLogs(rotating.deps, {
				filter: {},
				limit: 10,
				after: landed.newer,
			});

			expect(landed.records).toEqual(first.slice(2, 6));
			expect(older.records).toEqual(first.slice(0, 2));
			expect(older.more).toBe(false);
			expect(newer.records).toEqual([...first.slice(6), ...fresh]);
			expect(newer.more).toBe(false);
		});
	});

	it("caps a page at the read limit", async () => {
		const records = Array.from({ length: LOG_READ_LIMIT_MAX + 200 }, (_, i) =>
			engineRecord(i, "http", `r${i}`)
		);
		writeLog("engine_20261118_100000.log", records);

		const result = await readLogs(deps, { filter: {}, limit: 5000 });

		expect(result.records).toEqual(records.slice(200));
		expect(result.more).toBe(true);
	});

	it.each<[string, Partial<ReadLogsOptions>]>([
		["a zero limit", { limit: 0 }],
		["a fractional limit", { limit: 1.5 }],
		["both a cursor and a time", { before: { files: [] }, around: tsAt(0) }],
		["a time that is not a log ts", { around: "yesterday" }],
		[
			"a negative cursor offset",
			{ before: { files: [{ name: "engine_20261118_100000.log", id: "", offset: -1 }] } },
		],
	])("refuses %s", async (_label, overrides) => {
		writeLog("engine_20261118_100000.log", ENGINE_FIXTURE);
		await expect(readLogs(deps, { filter: {}, limit: 10, ...overrides })).rejects.toThrow();
	});
});

describe("readLogs - the scan budget", () => {
	function writeNoiseThenNeedle(count: number, pad: string): LogFileRecord {
		const needle = engineRecord(0, "oauth", "needle in the oldest record");
		const noise = Array.from({ length: count }, (_, i) =>
			engineRecord(i + 1, "http", "noise", { pad })
		);
		writeLog("engine_20261118_100000.log", [needle, ...noise]);
		return needle;
	}

	it("stops at 8 MiB with nothing matching, says how far it searched, and the next call continues", async () => {
		const needle = writeNoiseThenNeedle(7500, "p".repeat(1024));
		const filter: LogFilter = { text: "needle" };

		const first = await readLogs(deps, { filter, limit: 100 });
		expect(first.records).toEqual([]);
		expect(first.more).toBe(true);
		expect(first.scannedTo).not.toBeNull();
		expect(first.scannedTo! > needle.ts).toBe(true);

		const second = await readLogs(deps, { filter, limit: 100, before: first.cursor });
		expect(second.records).toEqual([needle]);
		expect(second.scannedTo).toBe(needle.ts);
		expect(second.more).toBe(false);
		expect(LOG_SCAN_BUDGET_BYTES).toBe(8 * 1024 * 1024);
	});

	it("pages a search through many budgets, each one further back, finding the match once", async () => {
		const needle = writeNoiseThenNeedle(300, "");
		const budgeted = { ...deps, scanBudgetBytes: 2048, chunkBytes: 256 };
		const filter: LogFilter = { text: "needle" };

		const reached: string[] = [];
		const found: LogEntry[] = [];
		let result = await readLogs(budgeted, { filter, limit: 100 });
		for (;;) {
			reached.push(result.scannedTo!);
			found.push(...result.records);
			if (!result.more) break;
			result = await readLogs(budgeted, { filter, limit: 100, before: result.cursor });
		}

		expect(found).toEqual([needle]);
		expect(reached.length).toBeGreaterThan(5);
		expect(reached).toEqual([...reached].sort().reverse());
		expect(new Set(reached).size).toBe(reached.length);
		expect(reached[reached.length - 1]).toBe(needle.ts);
	});
});

describe("readLogs - jump to time", () => {
	function writeTwoSources(): LogFileRecord[] {
		const engine: LogFileRecord[] = [];
		const app: LogFileRecord[] = [];
		for (let second = 0; second < 100; second++) {
			if (second % 2 === 0) engine.push(engineRecord(second, "http", `e${second}`));
			else app.push(engineRecord(second, "sidecar", `a${second}`, {}, "info", "app"));
		}
		writeLog("engine_20261118_100000.log", engine);
		writeLog("app_20261118_100000.log", app);
		return [...engine, ...app].sort((a, b) => (a.ts < b.ts ? -1 : 1));
	}

	it.each([0, 1, 37, 50, 98, 99])(
		"lands on the records at and before second %i",
		async (second) => {
			const all = writeTwoSources();

			const result = await readLogs(
				{ ...deps, chunkBytes: 50 },
				{ filter: {}, limit: 5, around: tsAt(second) }
			);

			expect(result.records).toEqual(all.slice(Math.max(0, second - 4), second + 1));
			expect(result.more).toBe(second > 4);
		}
	);

	it("lands between two records, before every record, and after every record", async () => {
		const all = writeTwoSources();
		const between = new Date(BASE_MS + 37_500).toISOString();

		const mid = await readLogs(deps, { filter: {}, limit: 3, around: between });
		const before = await readLogs(deps, { filter: {}, limit: 3, around: tsAt(-1) });
		const after = await readLogs(deps, { filter: {}, limit: 3, around: tsAt(500) });

		expect(mid.records).toEqual(all.slice(35, 38));
		expect(before.records).toEqual([]);
		expect(before.more).toBe(false);
		expect(after.records).toEqual(all.slice(97));
	});

	it("pages older from where it landed", async () => {
		const all = writeTwoSources();

		const landed = await readLogs(deps, { filter: {}, limit: 5, around: tsAt(50) });
		const older = await readLogs(deps, { filter: {}, limit: 5, before: landed.cursor });

		expect(older.records).toEqual(all.slice(41, 46));
	});
});

describe("readLogs - forward paging", () => {
	/** Every `after` page from @p cursor until none remains, oldest first, with each page's furthest `ts`. */
	async function readAllAfter(
		readerDeps: LogReaderDeps,
		options: Omit<ReadLogsOptions, "before" | "around" | "after">,
		cursor: ReadLogsOptions["after"]
	): Promise<{ records: LogEntry[]; reached: (string | null)[] }> {
		const records: LogEntry[] = [];
		const reached: (string | null)[] = [];
		let result = await readLogs(readerDeps, { ...options, after: cursor });
		for (;;) {
			records.push(...result.records);
			reached.push(result.scannedTo);
			if (!result.more) return { records, reached };
			result = await readLogs(readerDeps, { ...options, after: result.cursor });
		}
	}

	it("continues after the time a jump landed on: t+1 then t+2, never t-1 again", async () => {
		const at = (second: number, src = "engine") =>
			engineRecord(second, "http", `s${second}`, {}, "info", src);
		writeLog("engine_20261118_100000.log", [at(8), at(11)]);
		writeLog("app_20261118_100000.log", [at(9, "app"), at(12, "app")]);

		const landed = await readLogs(deps, { filter: {}, limit: 10, around: tsAt(10) });
		const after = await readLogs(deps, { filter: {}, limit: 10, after: landed.newer });

		expect(landed.records).toEqual([at(8), at(9, "app")]);
		expect(after.records).toEqual([at(11), at(12, "app")]);
		expect(after.more).toBe(false);
		expect(after.scannedTo).toBe(tsAt(12));
		expect(landed.newer).toBeDefined();
	});

	it("answers no `newer` on a read that is not a jump", async () => {
		writeLog("engine_20261118_100000.log", ENGINE_FIXTURE);

		const newest = await readLogs(deps, { filter: {}, limit: 2 });
		const older = await readLogs(deps, { filter: {}, limit: 2, before: newest.cursor });

		expect(newest.newer).toBeUndefined();
		expect(older.newer).toBeUndefined();
	});

	it.each([1, 7, 50, 65536])(
		"returns every record after the time once, in ts order, across files and pages (chunk %i bytes)",
		async (chunkBytes) => {
			const all: LogFileRecord[] = [];
			const engine: LogFileRecord[] = [];
			const app: LogFileRecord[] = [];
			for (let second = 0; second < 60; second++) {
				const record =
					second % 2 === 0
						? engineRecord(second, "http", `e${second} ✓ 日本語`)
						: engineRecord(second, "sidecar", `a${second}`, {}, "info", "app");
				(second % 2 === 0 ? engine : app).push(record);
				all.push(record);
			}
			writeLog("engine_20261118_100000.log", engine);
			writeLog("app_20261118_100000.log", app);
			const chunked = { ...deps, chunkBytes };

			const landed = await readLogs(chunked, { filter: {}, limit: 5, around: tsAt(20) });
			const { records } = await readAllAfter(chunked, { filter: {}, limit: 7 }, landed.newer);

			expect(records).toEqual(all.slice(21));
		}
	);

	it("continues on the renamed file after a rotation between pages, then reads the fresh one from its start", async () => {
		const name = "engine_20261118_100000.log";
		const first = Array.from({ length: 10 }, (_, second) =>
			engineRecord(second, "http", `r${second}`)
		);
		writeLog(name, first);
		const landed = await readLogs(deps, { filter: {}, limit: 4, around: tsAt(3) });
		const page1 = await readLogs(deps, { filter: {}, limit: 3, after: landed.newer });
		renameSync(path.join(dir, name), path.join(dir, `${name}.1`));
		const fresh = [engineRecord(10, "http", "after rotation")];
		writeLog(name, fresh);

		const page2 = await readLogs(deps, { filter: {}, limit: 3, after: page1.cursor });
		const page3 = await readLogs(deps, { filter: {}, limit: 3, after: page2.cursor });

		expect(page1.records).toEqual(first.slice(4, 7));
		expect(page2.records).toEqual(first.slice(7, 10));
		expect(page3.records).toEqual(fresh);
		expect(page3.more).toBe(false);
	});

	it("continues on a file rotated between the listing and the open, never reading it twice", async () => {
		const name = "engine_20261118_100000.log";
		const first = Array.from({ length: 10 }, (_, second) =>
			engineRecord(second, "http", `r${second}`)
		);
		const fresh = [engineRecord(10, "http", "after rotation")];
		writeLog(name, first);
		let rotateOnOpen = false;
		const rotatingFs: LogReaderDeps["fs"] = {
			readdir: (target) => fs.promises.readdir(target),
			lstat: (target, options) => fs.promises.lstat(target, options),
			open: async (target, flags) => {
				if (rotateOnOpen) {
					// The listing saw the file under its name; it is `.1` by the open.
					rotateOnOpen = false;
					renameSync(path.join(dir, name), path.join(dir, `${name}.1`));
					writeLog(name, fresh);
				}
				return fs.promises.open(target, flags);
			},
		};
		const rotating = { ...deps, fs: rotatingFs };
		const landed = await readLogs(rotating, { filter: {}, limit: 4, around: tsAt(3) });
		const page1 = await readLogs(rotating, { filter: {}, limit: 3, after: landed.newer });

		rotateOnOpen = true;
		const raced = await readLogs(rotating, { filter: {}, limit: 3, after: page1.cursor });
		const { records } = await readAllAfter(rotating, { filter: {}, limit: 3 }, raced.cursor);

		expect(page1.records).toEqual(first.slice(4, 7));
		expect(raced.more).toBe(true);
		expect([...raced.records, ...records]).toEqual([...first.slice(7), ...fresh]);
	});

	it("holds back a half-written last line in the live file, and returns it once its newline lands", async () => {
		const file = path.join(dir, "engine_20261118_100000.log");
		const whole = line(ENGINE_FIXTURE[1]);
		writeFileSync(file, line(ENGINE_FIXTURE[0]) + whole.slice(0, 30));

		const first = await readLogs(deps, { filter: {}, limit: 10, after: { files: [] } });
		appendFileSync(file, whole.slice(30));
		const second = await readLogs(deps, { filter: {}, limit: 10, after: first.cursor });

		expect(first.records).toEqual([ENGINE_FIXTURE[0]]);
		expect(first.more).toBe(false);
		expect(second.records).toEqual([ENGINE_FIXTURE[1]]);
	});

	it("pages a search forward through many budgets, each one further on, finding the match once", async () => {
		const noise = Array.from({ length: 300 }, (_, i) => engineRecord(i, "http", "noise"));
		const needle = engineRecord(300, "oauth", "needle in the newest record");
		writeLog("engine_20261118_100000.log", [...noise, needle]);
		const budgeted = { ...deps, scanBudgetBytes: 2048, chunkBytes: 256 };

		const first = await readLogs(budgeted, {
			filter: { text: "needle" },
			limit: 100,
			after: { files: [] },
		});
		const { records, reached } = await readAllAfter(
			budgeted,
			{ filter: { text: "needle" }, limit: 100 },
			{ files: [] }
		);

		expect(first.records).toEqual([]);
		expect(first.more).toBe(true);
		expect(records).toEqual([needle]);
		expect(reached.length).toBeGreaterThan(5);
		expect(reached).toEqual([...reached].sort());
		expect(new Set(reached).size).toBe(reached.length);
		expect(reached[reached.length - 1]).toBe(needle.ts);
	});

	it("applies the filter", async () => {
		writeLog("engine_20261118_100000.log", [engineRecord(1, "http", "e1")]);
		const app = engineRecord(2, "sidecar", "a2", {}, "info", "app");
		writeLog("app_20261118_100000.log", [app]);

		const result = await readLogs(deps, {
			filter: { sources: ["app"] },
			limit: 10,
			after: { files: [] },
		});

		expect(result.records).toEqual([app]);
	});

	it.each<[string, Partial<ReadLogsOptions>]>([
		["a forward and a backward cursor", { after: { files: [] }, before: { files: [] } }],
		["a forward cursor and a time", { after: { files: [] }, around: tsAt(0) }],
		[
			"a forward cursor with a path",
			{ after: { files: [{ name: "../x", id: "", offset: 0 }] } },
		],
	])("refuses %s", async (_label, overrides) => {
		writeLog("engine_20261118_100000.log", ENGINE_FIXTURE);
		await expect(readLogs(deps, { filter: {}, limit: 10, ...overrides })).rejects.toThrow();
	});
});

describe("the filter", () => {
	const oauthFailure = engineRecord(
		0,
		"oauth",
		"Token request failed",
		{ status: 500, runId: "run-abc", lines: ["< HTTP/1.1 503"] },
		"warn"
	);
	const record = (overrides: Record<string, unknown>) =>
		({ ...oauthFailure, ...overrides }) as LogFileRecord;
	const unparsedLine: LogEntry = { unparsed: true, raw: "segfault in worker" };

	const keeps = (filter: LogFilter, entry: LogEntry = record({})) =>
		compileLogFilter(filter)(entry);

	it("keeps everything when it constrains nothing", () => {
		expect(keeps({})).toBe(true);
		expect(keeps({ sources: [], categories: [], text: "  ", terms: [] })).toBe(true);
		expect(keeps({}, unparsedLine)).toBe(true);
	});

	it("applies a minimum level", () => {
		expect(keeps({ minLevel: "warn" })).toBe(true);
		expect(keeps({ minLevel: "error" })).toBe(false);
		expect(keeps({ minLevel: "warn" }, record({ level: "info" }))).toBe(false);
		expect(keeps({ minLevel: "info" }, record({ level: "debug" }))).toBe(false);
	});

	it("applies a set of sources and a set of categories", () => {
		expect(keeps({ sources: ["engine", "cli"] })).toBe(true);
		expect(keeps({ sources: ["app"] })).toBe(false);
		expect(keeps({ categories: ["oauth"] })).toBe(true);
		expect(keeps({ categories: ["http"] })).toBe(false);
	});

	it("matches free text case-insensitively over the message and string field values at any depth", () => {
		expect(keeps({ text: "TOKEN request" })).toBe(true);
		expect(keeps({ text: "run-ABC" })).toBe(true);
		expect(keeps({ text: "http/1.1 503" })).toBe(true);
		expect(keeps({ text: "nowhere" })).toBe(false);
		// The columns of their own are not searched as text.
		expect(keeps({ text: "oauth" })).toBe(false);
	});

	it("matches a bare field term as a substring and a quoted one exactly, a number by its string form", () => {
		expect(keeps({ terms: [{ field: "status", value: "500", exact: false }] })).toBe(true);
		expect(keeps({ terms: [{ field: "status", value: "50", exact: false }] })).toBe(true);
		expect(keeps({ terms: [{ field: "status", value: "500", exact: true }] })).toBe(true);
		expect(keeps({ terms: [{ field: "status", value: "50", exact: true }] })).toBe(false);
		expect(keeps({ terms: [{ field: "runId", value: "ABC", exact: false }] })).toBe(true);
		expect(keeps({ terms: [{ field: "runId", value: "run-ABC", exact: true }] })).toBe(false);
		expect(keeps({ terms: [{ field: "cat", value: "oauth", exact: true }] })).toBe(true);
		expect(keeps({ terms: [{ field: "missing", value: "x", exact: false }] })).toBe(false);
	});

	it("also matches a bare term as the text it was typed as, so host:port finds a URL (#3678)", () => {
		const withUrl = record({ url: "http://localhost:47813/x" });
		const hostPort = { field: "localhost", value: "47813", exact: false };
		expect(keeps({ terms: [hostPort] }, withUrl)).toBe(true);
		expect(keeps({ terms: [{ ...hostPort, value: "47814" }] }, withUrl)).toBe(false);
		expect(
			keeps({ terms: [{ field: "LOCALHOST", value: "47813", exact: false }] }, withUrl)
		).toBe(true);
		expect(keeps({ terms: [hostPort] })).toBe(false);
		// A quoted term stays an exact field match.
		expect(keeps({ terms: [{ ...hostPort, exact: true }] }, withUrl)).toBe(false);
	});

	it("keeps a bare term narrowing by its field when the text does not hold it", () => {
		expect(keeps({ terms: [{ field: "status", value: "500", exact: false }] })).toBe(true);
		expect(
			keeps(
				{ terms: [{ field: "status", value: "500", exact: false }] },
				record({ status: 200 })
			)
		).toBe(false);
		expect(
			keeps(
				{ terms: [{ field: "cat", value: "oauth", exact: false }] },
				record({ cat: "http" })
			)
		).toBe(false);
		// The text alternative is the same text free text searches: `cat` is not in it.
		expect(
			keeps(
				{ terms: [{ field: "cat", value: "oauth", exact: false }] },
				record({ cat: "oauth" })
			)
		).toBe(true);
	});

	it("finds the same lines for host:port, the quoted phrase and the host alone", () => {
		const lines = [
			record({ url: "http://localhost:47813/x" }),
			record({ message: "listening on localhost:47813" }),
			record({ message: "unrelated" }),
		] as LogEntry[];
		const linesFor = (input: string) => {
			const { text, terms } = parseSearchInput(input);
			return lines.filter(compileLogFilter({ text, terms }));
		};

		const expected = lines.slice(0, 2);
		expect(linesFor("localhost:47813")).toEqual(expected);
		expect(linesFor(`"localhost:47813"`)).toEqual(expected);
		expect(linesFor("localhost")).toEqual(expected);
	});

	it("ANDs its terms and its constraints", () => {
		const status = { field: "status", value: "500", exact: true };
		expect(keeps({ terms: [status, { field: "cat", value: "oauth", exact: false }] })).toBe(
			true
		);
		expect(keeps({ terms: [status, { field: "cat", value: "http", exact: false }] })).toBe(
			false
		);
		expect(
			keeps({ minLevel: "warn", sources: ["engine"], text: "token", terms: [status] })
		).toBe(true);
		expect(keeps({ minLevel: "warn", sources: ["app"], text: "token", terms: [status] })).toBe(
			false
		);
	});

	it("keeps an unparsed line only for a filter it can be judged by, matching text on the raw line", () => {
		expect(keeps({ text: "SEGFAULT" }, unparsedLine)).toBe(true);
		expect(keeps({ text: "token" }, unparsedLine)).toBe(false);
		expect(keeps({ minLevel: "info" }, unparsedLine)).toBe(false);
		expect(keeps({ sources: ["engine"] }, unparsedLine)).toBe(false);
		expect(keeps({ terms: [{ field: "raw", value: "seg", exact: false }] }, unparsedLine)).toBe(
			false
		);
	});

	it("is the filter a read applies", async () => {
		writeLog("engine_20261118_100000.log", ENGINE_FIXTURE);

		const { records } = await readLogs(deps, { filter: { minLevel: "warn" }, limit: 10 });

		expect(records).toEqual([ENGINE_FIXTURE[2], ENGINE_FIXTURE[4]]);
	});
});

describe("parseSearchInput", () => {
	it("splits a search into free text and field terms", () => {
		expect(
			parseSearchInput(`token failed status:500 cat:"oauth" "two  words" runId:"a b"`)
		).toEqual({
			text: "token failed two  words",
			terms: [
				{ field: "status", value: "500", exact: false },
				{ field: "cat", value: "oauth", exact: true },
				{ field: "runId", value: "a b", exact: true },
			],
		});
	});

	it("leaves a URL, an empty value and a name that is not a field name in the free text", () => {
		expect(parseSearchInput("http://host/x status: Status:5 :x")).toEqual({
			text: "http://host/x status: Status:5 :x",
			terms: [],
		});
	});

	it("answers nothing for an empty search", () => {
		expect(parseSearchInput("   ")).toEqual({ text: "", terms: [] });
	});
});

describe("each line's position", () => {
	const name = "engine_20261118_100000.log";
	/** A record, a CRLF record, a line that is not one and a record with multi-byte text. */
	const LINES = [
		line(ENGINE_FIXTURE[0]),
		JSON.stringify(ENGINE_FIXTURE[1]) + "\r\n",
		"not json at all\n",
		line(ENGINE_FIXTURE[5]),
	];

	/** Where each of @p lines sits in @p file, written in order from @p from. */
	function expectedPositions(file: string, lines: string[], from = 0): LogLinePosition[] {
		const id = fileId(file);
		let start = from;
		return lines.map((text) => {
			const end = start + Buffer.byteLength(text);
			const position = { name: file, id, start, end };
			start = end;
			return position;
		});
	}

	const positions = (records: LogEntry[]) => records.map((entry) => entry[POSITION_KEY]);

	it.each([1, 7, 65536])(
		"is exact on a backward read, for lines that span chunks too (chunk %i bytes)",
		async (chunkBytes) => {
			writeFileSync(path.join(dir, name), LINES.join(""));

			const { records } = await readLogsWithRaw(
				{ ...deps, chunkBytes },
				{ filter: {}, limit: 10 }
			);

			expect(positions(records)).toEqual(expectedPositions(name, LINES));
		}
	);

	it.each([1, 7, 65536])(
		"is exact on a forward read, for lines that span chunks too (chunk %i bytes)",
		async (chunkBytes) => {
			writeFileSync(path.join(dir, name), LINES.join(""));

			const { records } = await readLogsWithRaw(
				{ ...deps, chunkBytes },
				{ filter: {}, limit: 10, after: { files: [] } }
			);

			expect(positions(records)).toEqual(expectedPositions(name, LINES));
		}
	);

	it("ends at the file's end for a last line with no newline, read either way", async () => {
		const older = "engine_20261118_090000.log";
		const unterminated = [line(ENGINE_FIXTURE[0]), JSON.stringify(ENGINE_FIXTURE[1])];
		writeFileSync(path.join(dir, older), unterminated.join(""));
		// A newer file of the same source, so the older one has no writer.
		writeLog(name, [ENGINE_FIXTURE[2]]);
		const expected = [
			...expectedPositions(older, unterminated),
			...expectedPositions(name, [line(ENGINE_FIXTURE[2])]),
		];

		const backward = await readLogsWithRaw(deps, { filter: {}, limit: 10 });
		const forward = await readLogsWithRaw(deps, {
			filter: {},
			limit: 10,
			after: { files: [] },
		});

		expect(positions(backward.records)).toEqual(expected);
		expect(positions(forward.records)).toEqual(expected);
	});

	it("is exact on what the tail delivers, for a line written in two halves too", async () => {
		const file = path.join(dir, name);
		writeLog(name, [ENGINE_FIXTURE[0]]);
		const clock = manualTimers();
		const batches: LogBatch[] = [];
		const tail = await createLogTail(
			{ ...deps, chunkBytes: 7, timers: clock.timers },
			{ filter: {}, onBatch: (batch) => batches.push(batch) }
		);
		const appended = [line(ENGINE_FIXTURE[1]), "not json at all\n", line(ENGINE_FIXTURE[2])];

		appendFileSync(file, appended[0] + appended[1] + appended[2].slice(0, 20));
		await clock.poll();
		appendFileSync(file, appended[2].slice(20));
		await clock.poll();

		expect(positions(batches.flatMap((batch) => batch.records))).toEqual(
			expectedPositions(name, appended, Buffer.byteLength(line(ENGINE_FIXTURE[0])))
		);
		tail.stop();
	});

	it("names the renamed file by the same identity after a rotation between pages", async () => {
		const first = Array.from({ length: 8 }, (_, second) =>
			engineRecord(second, "http", `r${second}`)
		);
		writeLog(name, first);
		const page1 = await readLogsWithRaw(deps, { filter: {}, limit: 4 });
		renameSync(path.join(dir, name), path.join(dir, `${name}.1`));
		writeLog(name, [engineRecord(10, "http", "after rotation")]);

		const page2 = await readLogsWithRaw(deps, { filter: {}, limit: 4, before: page1.cursor });

		const before = positions(page1.records);
		const after = positions(page2.records);
		expect(before.map((position) => position?.name)).toEqual(Array(4).fill(name));
		expect(after.map((position) => position?.name)).toEqual(Array(4).fill(`${name}.1`));
		expect(new Set([...before, ...after].map((position) => position?.id)).size).toBe(1);
		expect(after[3]?.end).toBe(before[0]?.start);
	});

	it("is not searched by free text", async () => {
		writeLog(name, [ENGINE_FIXTURE[0]]);

		const byFileName = await readLogsWithRaw(deps, {
			filter: { text: "100000.log" },
			limit: 5,
		});
		const byValue = await readLogsWithRaw(deps, { filter: { text: "starting" }, limit: 5 });

		expect(byFileName.records).toEqual([]);
		expect(byValue.records).toHaveLength(1);
	});
});

describe("trust", () => {
	const listed = "engine_20261118_100000.log";

	it.each([
		["a parent segment", () => `../${listed}`],
		["a separator", () => `sub/${listed}`],
		["a Windows separator", () => `sub\\${listed}`],
		["an absolute path", () => path.join(root, listed)],
		["a name outside the pattern", () => "notes.log"],
		["a second rotation generation", () => `${listed}.2`],
	])("refuses a cursor naming %s", async (_label, name) => {
		writeLog(listed, ENGINE_FIXTURE);
		// What each traversal would reach, so a missing check reads records.
		writeFileSync(path.join(root, listed), ENGINE_FIXTURE.map(line).join(""));
		mkdirSync(path.join(dir, "sub"));
		writeFileSync(path.join(dir, "sub", listed), ENGINE_FIXTURE.map(line).join(""));

		await expect(
			readLogs(deps, {
				filter: {},
				limit: 10,
				before: { files: [{ name: name(), id: "", offset: 1_000_000 }] },
			})
		).rejects.toThrow(/Not a log file name/);
	});

	it("never reads a file outside the pattern", async () => {
		writeFileSync(path.join(dir, "notes.log"), line(ENGINE_FIXTURE[0]));
		writeFileSync(path.join(dir, "engine.log"), line(ENGINE_FIXTURE[1]));

		expect((await readLogs(deps, { filter: {}, limit: 10 })).records).toEqual([]);
	});

	it("neither lists nor reads a symlink, even one named like a log file", async (context) => {
		const target = path.join(root, "secret.log");
		writeFileSync(target, line(ENGINE_FIXTURE[0]));
		const linkName = "engine_20261118_100000.log";
		try {
			symlinkSync(target, path.join(dir, linkName));
		} catch {
			// Windows without Developer Mode cannot create one; nothing to refuse.
			context.skip();
		}

		expect(await listLogFiles(deps)).toEqual([]);
		expect((await readLogs(deps, { filter: {}, limit: 10 })).records).toEqual([]);
		const viaCursor = await readLogs(deps, {
			filter: {},
			limit: 10,
			before: { files: [{ name: linkName, id: "", offset: 1000 }] },
		});
		expect(viaCursor.records).toEqual([]);
	});
});

/**
 * Timers the test fires by hand. `poll()` runs the scheduled poll and
 * resolves when it schedules the next, which it does once it has finished.
 */
function manualTimers() {
	let pending: { callback: () => void; token: object } | null = null;
	let onScheduled: (() => void) | null = null;
	const timers: LogTailTimers = {
		setTimeout(callback, ms) {
			expect(ms).toBe(LOG_TAIL_POLL_MS);
			const token = {};
			pending = { callback, token };
			onScheduled?.();
			onScheduled = null;
			return token;
		},
		clearTimeout(handle) {
			if (pending?.token === handle) pending = null;
		},
	};
	const take = () => {
		const current = pending;
		if (!current) throw new Error("no poll is scheduled");
		pending = null;
		return current.callback;
	};
	return {
		timers,
		isScheduled: () => pending !== null,
		/** Start the poll without waiting for it. */
		fire: () => take()(),
		async poll() {
			const callback = take();
			const finished = new Promise<void>((resolve) => (onScheduled = resolve));
			callback();
			await finished;
		},
	};
}

async function startTail(filter: LogFilter = {}, readerDeps: LogReaderDeps = deps) {
	const clock = manualTimers();
	const batches: LogBatch[] = [];
	const tail = await createLogTail(
		{ ...readerDeps, timers: clock.timers },
		{
			filter,
			onBatch: (batch) => batches.push({ ...batch, records: batch.records.map(asFixture) }),
		}
	);
	return { clock, batches, tail };
}

describe("createLogTail", () => {
	const engineLog = "engine_20261118_100000.log";

	it("delivers what is appended after it starts, not what was there before", async () => {
		writeLog(engineLog, ENGINE_FIXTURE.slice(0, 2));
		const { clock, batches, tail } = await startTail();

		appendFileSync(
			path.join(dir, engineLog),
			line(ENGINE_FIXTURE[2]) + line(ENGINE_FIXTURE[3])
		);
		await clock.poll();
		await clock.poll();

		expect(batches).toEqual([{ records: ENGINE_FIXTURE.slice(2, 4), dropped: 0 }]);
		tail.stop();
	});

	it("holds a half-written line until its newline arrives", async () => {
		writeLog(engineLog, [ENGINE_FIXTURE[0]]);
		const { clock, batches, tail } = await startTail();
		const text = line(ENGINE_FIXTURE[1]);

		appendFileSync(path.join(dir, engineLog), text.slice(0, 25));
		await clock.poll();
		expect(batches).toEqual([]);

		appendFileSync(path.join(dir, engineLog), text.slice(25));
		await clock.poll();
		expect(batches).toEqual([{ records: [ENGINE_FIXTURE[1]], dropped: 0 }]);
		tail.stop();
	});

	it("delivers whole a line that was mid-write when it started", async () => {
		const text = line(ENGINE_FIXTURE[1]);
		writeFileSync(path.join(dir, engineLog), line(ENGINE_FIXTURE[0]) + text.slice(0, 40));
		const { clock, batches, tail } = await startTail();

		appendFileSync(path.join(dir, engineLog), text.slice(40));
		await clock.poll();

		expect(batches).toEqual([{ records: [ENGINE_FIXTURE[1]], dropped: 0 }]);
		tail.stop();
	});

	it("follows the real logger through a rotation: the renamed file's rest, then the fresh file", async () => {
		let clock = BASE_MS;
		const logger = createLogger("app", {
			logsDir: dir,
			consoleEnabled: false,
			now: () => new Date((clock += 1000)),
			pid: 777,
			maxFileBytes: 700,
		});
		logger.applyFloor("debug");
		logger.info("main", "before the tail");
		const tailing = await startTail();
		const appLog = (await listLogFiles(deps))[0].name;

		let written = 0;
		while (!fs.existsSync(path.join(dir, `${appLog}.1`)))
			logger.info("main", `record ${++written}`);
		logger.info("main", `record ${++written}`);
		await tailing.clock.poll();

		const delivered = tailing.batches.flatMap((batch) => batch.records) as LogFileRecord[];
		expect(written).toBeGreaterThan(2);
		expect(delivered.map((record) => record.msg)).toEqual(
			Array.from({ length: written }, (_, i) => `record ${i + 1}`)
		);
		tailing.tail.stop();
	});

	it("reads a file that appears after it started, a restarted engine's, from its start", async () => {
		writeLog(engineLog, [ENGINE_FIXTURE[0]]);
		const { clock, batches, tail } = await startTail();
		await clock.poll();

		writeLog("engine_20261118_120000.log", ENGINE_FIXTURE.slice(1, 3));
		await clock.poll();

		expect(batches).toEqual([{ records: ENGINE_FIXTURE.slice(1, 3), dropped: 0 }]);
		tail.stop();
	});

	it("delivers the newest records of a burst over the batch bound, and how many it dropped", async () => {
		writeLog(engineLog, []);
		const { clock, batches, tail } = await startTail();
		const burst = Array.from({ length: LOG_TAIL_BATCH_MAX + 700 }, (_, i) =>
			engineRecord(i, "http", `r${i}`)
		);

		appendFileSync(path.join(dir, engineLog), burst.map(line).join(""));
		await clock.poll();
		await clock.poll();

		expect(batches).toEqual([{ records: burst.slice(700), dropped: 700 }]);
		tail.stop();
	});

	it("applies the filter, and delivers a line that is not a record as unparsed", async () => {
		writeLog(engineLog, []);
		const { clock, batches, tail } = await startTail({ text: "fail" });

		appendFileSync(
			path.join(dir, engineLog),
			ENGINE_FIXTURE.map(line).join("") + "fail: not json\n"
		);
		await clock.poll();

		expect(batches).toEqual([
			{
				records: [
					ENGINE_FIXTURE[2],
					ENGINE_FIXTURE[4],
					{ unparsed: true, raw: "fail: not json" },
				],
				dropped: 0,
			},
		]);
		tail.stop();
	});

	it("keeps following the other files when one it followed is deleted", async () => {
		writeLog(engineLog, []);
		writeLog("app_20261118_100000.log", []);
		const { clock, batches, tail } = await startTail();

		rmSync(path.join(dir, engineLog));
		appendFileSync(path.join(dir, "app_20261118_100000.log"), line(ENGINE_FIXTURE[0]));
		await clock.poll();

		expect(batches).toEqual([{ records: [ENGINE_FIXTURE[0]], dropped: 0 }]);
		expect(clock.isScheduled()).toBe(true);
		tail.stop();
	});

	it("stops polling on stop", async () => {
		writeLog(engineLog, []);
		const { clock, batches, tail } = await startTail();
		expect(clock.isScheduled()).toBe(true);

		tail.stop();
		appendFileSync(path.join(dir, engineLog), line(ENGINE_FIXTURE[0]));

		expect(clock.isScheduled()).toBe(false);
		expect(batches).toEqual([]);
	});

	it("delivers nothing and schedules nothing from a poll in flight when it stops", async () => {
		writeLog(engineLog, []);
		let releaseListing!: () => void;
		const listingHeld = new Promise<void>((resolve) => (releaseListing = resolve));
		let gate = false;
		let listingReached!: () => void;
		const reached = new Promise<void>((resolve) => (listingReached = resolve));
		let closed!: () => void;
		const handleClosed = new Promise<void>((resolve) => (closed = resolve));
		const gatedFs: LogReaderDeps["fs"] = {
			readdir: async (target) => {
				if (gate) {
					listingReached();
					await listingHeld;
				}
				return fs.promises.readdir(target);
			},
			lstat: (target, options) => fs.promises.lstat(target, options),
			open: async (target, flags) => {
				const handle = await fs.promises.open(target, flags);
				return {
					read: (...args) => handle.read(...args),
					stat: (options) => handle.stat(options),
					close: async () => {
						await handle.close();
						if (gate) closed();
					},
				};
			},
		};
		const { clock, batches, tail } = await startTail({}, { ...deps, fs: gatedFs });
		gate = true;
		appendFileSync(path.join(dir, engineLog), line(ENGINE_FIXTURE[0]));

		clock.fire();
		await reached;
		tail.stop();
		releaseListing();
		await handleClosed;
		// Everything after the last close runs as microtasks; a macrotask turn drains them.
		await new Promise((resolve) => setImmediate(resolve));

		expect(batches).toEqual([]);
		expect(clock.isScheduled()).toBe(false);
	});
});
