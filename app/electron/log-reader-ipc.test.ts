/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Logs tab's IPC (#3635) over a real reader and a temp directory: who may
 * ask, what shape a request must have, and the life of a window's tail. The
 * tail's poll is driven by injected timers (`log-reader.test.ts` says why).
 *
 * Mutation checks: drop the `isAppFrame` check from one handler and its
 * refusal case reds; drop `watch(sender)` from `startTail` and the destroyed
 * and navigation cases red; keep the tail a stale start returns and the
 * overlapping-start cases red; build the options from the payload without
 * `readLogsRequest` and the malformed cases red.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcSenderLike } from "./ipc-sender";
import {
	LOGS_LIST_CHANNEL,
	LOGS_READ_CHANNEL,
	LOGS_RECORDS_CHANNEL,
	LOGS_TAIL_START_CHANNEL,
	LOGS_TAIL_STOP_CHANNEL,
	registerLogReaderIpc,
	type LogReaderEvent,
	type LogReaderIpc,
} from "./log-reader-ipc";
import { LOG_TAIL_POLL_MS, type LogBatch, type LogTailTimers } from "./log-reader";
import type { NavigationDetails } from "./renderer-watch";

type Handler = (event: LogReaderEvent, ...args: unknown[]) => unknown;

/** `ipcMain`'s `handle`, remembering each listener by channel. */
function fakeIpc() {
	const handlers = new Map<string, Handler>();
	return {
		ipc: {
			handle: (channel: string, listener: Handler) => void handlers.set(channel, listener),
		},
		invoke: async (channel: string, event: LogReaderEvent, ...args: unknown[]) => {
			const handler = handlers.get(channel);
			if (!handler) throw new Error(`no handler on ${channel}`);
			return handler(event, ...args);
		},
		channels: () => [...handlers.keys()].sort(),
	};
}

/** A `webContents` that records its sends and lets a test fire its lifecycle events. */
function fakeSender(id: number) {
	let onDestroyed: (() => void) | null = null;
	const navigationListeners: ((details: NavigationDetails) => void)[] = [];
	const sender = {
		id,
		send: vi.fn<(channel: string, payload: LogBatch) => void>(),
		once: (_event: "destroyed", listener: () => void) => void (onDestroyed = listener),
		on: (_event: "did-start-navigation", listener: (details: NavigationDetails) => void) =>
			void navigationListeners.push(listener),
	};
	const event: LogReaderEvent = { sender, senderFrame: {} };
	return {
		sender,
		event,
		destroy: () => onDestroyed?.(),
		navigate: (details: NavigationDetails) => navigationListeners.forEach((fn) => fn(details)),
		batches: () => sender.send.mock.calls.map(([, batch]) => batch),
	};
}

/**
 * Timers a test advances. `poll` fires every scheduled poll and resolves when
 * each has scheduled its successor, which is the moment it has finished; only
 * a tail that is still running does.
 */
function manualTimers() {
	const pending = new Map<object, () => void>();
	let onScheduled: (() => void) | null = null;
	const timers: LogTailTimers = {
		setTimeout(callback, ms) {
			expect(ms).toBe(LOG_TAIL_POLL_MS);
			const token = {};
			pending.set(token, callback);
			onScheduled?.();
			return token;
		},
		clearTimeout: (token) => void pending.delete(token as object),
	};
	return {
		timers,
		scheduled: () => pending.size,
		async poll() {
			const due = [...pending.values()];
			pending.clear();
			let rescheduled = 0;
			const finished = new Promise<void>((resolve) => {
				onScheduled = () => {
					rescheduled += 1;
					if (rescheduled === due.length) resolve();
				};
			});
			due.forEach((callback) => callback());
			await finished;
			onScheduled = null;
		},
	};
}

let root: string;
let dir: string;
let logFile: string;
let clock: ReturnType<typeof manualTimers>;
let ipc: ReturnType<typeof fakeIpc>;
let isAppFrame: ReturnType<typeof vi.fn<(event: IpcSenderLike) => boolean>>;
let registered: LogReaderIpc;

const BASE_MS = Date.parse("2026-11-18T10:00:00.000Z");

function record(second: number, cat: string, msg: string, level = "info") {
	return {
		ts: new Date(BASE_MS + second * 1000).toISOString(),
		level,
		src: "engine",
		cat,
		msg,
		pid: 4242,
	};
}

const line = (value: object) => JSON.stringify(value) + "\n";

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "vayu-log-reader-ipc-"));
	dir = path.join(root, "logs");
	mkdirSync(dir);
	logFile = path.join(dir, "engine_20261118_100000.log");
	writeFileSync(
		logFile,
		line(record(0, "startup", "starting")) + line(record(1, "http", "answered"))
	);
	clock = manualTimers();
	ipc = fakeIpc();
	isAppFrame = vi.fn(() => true);
	registered = registerLogReaderIpc(ipc.ipc, {
		isAppFrame,
		logsPath: () => dir,
		fs: fs.promises,
		timers: clock.timers,
	});
});

afterEach(() => {
	registered.stopAll();
	rmSync(root, { recursive: true, force: true });
});

describe("the channels", () => {
	it("registers the four invoke channels the renderer API names", () => {
		expect(ipc.channels()).toEqual(
			[
				LOGS_LIST_CHANNEL,
				LOGS_READ_CHANNEL,
				LOGS_TAIL_START_CHANNEL,
				LOGS_TAIL_STOP_CHANNEL,
			].sort()
		);
		expect(LOGS_RECORDS_CHANNEL).toBe("logs:records");
	});
});

describe("a sender outside the app window", () => {
	it.each([
		[LOGS_LIST_CHANNEL, []],
		[LOGS_READ_CHANNEL, [{ filter: {}, limit: 10 }]],
		[LOGS_TAIL_START_CHANNEL, [{}]],
		[LOGS_TAIL_STOP_CHANNEL, []],
	])("is refused on %s", async (channel, args) => {
		isAppFrame.mockReturnValue(false);
		const window = fakeSender(1);

		await expect(ipc.invoke(channel, window.event, ...args)).rejects.toThrow(
			"Refused: logs are read only from the Vayu window."
		);

		expect(isAppFrame).toHaveBeenCalledWith(window.event);
		expect(clock.scheduled()).toBe(0);
	});

	it("is refused before its payload is looked at", async () => {
		isAppFrame.mockReturnValue(false);

		await expect(ipc.invoke(LOGS_READ_CHANNEL, fakeSender(1).event, null)).rejects.toThrow(
			/Vayu window/
		);
	});

	it("cannot stop the tail of the app window", async () => {
		const window = fakeSender(1);
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, {});
		isAppFrame.mockReturnValue(false);

		await expect(ipc.invoke(LOGS_TAIL_STOP_CHANNEL, fakeSender(1).event)).rejects.toThrow();

		expect(clock.scheduled()).toBe(1);
	});
});

describe("logs:list and logs:read", () => {
	it("lists the files of the logs directory by name", async () => {
		writeFileSync(path.join(dir, "notes.txt"), "not a log");

		const files = await ipc.invoke(LOGS_LIST_CHANNEL, fakeSender(1).event);

		expect(files).toEqual([
			expect.objectContaining({ name: "engine_20261118_100000.log", source: "engine" }),
		]);
	});

	it("reads a page, then the page before it from the cursor it returned", async () => {
		const window = fakeSender(1);
		const newest = await ipc.invoke(LOGS_READ_CHANNEL, window.event, { filter: {}, limit: 1 });
		const older = await ipc.invoke(LOGS_READ_CHANNEL, window.event, {
			filter: {},
			limit: 1,
			before: (newest as { cursor: unknown }).cursor,
		});

		expect((newest as { records: { msg: string }[] }).records.map((r) => r.msg)).toEqual([
			"answered",
		]);
		expect((older as { records: { msg: string }[] }).records.map((r) => r.msg)).toEqual([
			"starting",
		]);
	});

	it("reads the page after a jump from the `newer` cursor it returned", async () => {
		const window = fakeSender(1);
		const landed = await ipc.invoke(LOGS_READ_CHANNEL, window.event, {
			filter: {},
			limit: 10,
			around: record(0, "x", "y").ts,
		});
		const newer = await ipc.invoke(LOGS_READ_CHANNEL, window.event, {
			filter: {},
			limit: 10,
			after: (landed as { newer: unknown }).newer,
		});

		expect((landed as { records: { msg: string }[] }).records.map((r) => r.msg)).toEqual([
			"starting",
		]);
		expect((newer as { records: { msg: string }[] }).records.map((r) => r.msg)).toEqual([
			"answered",
		]);
	});

	it("applies the filter the renderer sent", async () => {
		const result = await ipc.invoke(LOGS_READ_CHANNEL, fakeSender(1).event, {
			filter: { categories: ["http"] },
			limit: 10,
		});

		expect((result as { records: { cat: string }[] }).records.map((r) => r.cat)).toEqual([
			"http",
		]);
	});

	it("reads the directory main holds, whatever the payload says", async () => {
		const elsewhere = mkdtempSync(path.join(tmpdir(), "vayu-log-reader-other-"));
		try {
			writeFileSync(
				path.join(elsewhere, "engine_20261118_100000.log"),
				line(record(9, "x", "no"))
			);

			const result = await ipc.invoke(LOGS_READ_CHANNEL, fakeSender(1).event, {
				filter: {},
				limit: 10,
				logsDir: elsewhere,
				path: elsewhere,
			});

			expect((result as { records: { msg: string }[] }).records.map((r) => r.msg)).toEqual([
				"starting",
				"answered",
			]);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});

const OK_CURSOR = { files: [{ name: "engine_20261118_100000.log", id: "", offset: 10 }] };

describe("a payload of the wrong shape", () => {
	it.each<[string, unknown]>([
		["no payload", undefined],
		["null", null],
		["a string", "engine_20261118_100000.log"],
		["an array", []],
		["no limit", { filter: {} }],
		["a limit of text", { filter: {}, limit: "10" }],
		["no filter", { limit: 10 }],
		["a filter that is a list", { filter: [], limit: 10 }],
		["a minimum level that is not one", { filter: { minLevel: "trace" }, limit: 10 }],
		["a minimum level from the prototype", { filter: { minLevel: "toString" }, limit: 10 }],
		["sources that are text", { filter: { sources: "engine" }, limit: 10 }],
		["a source that is a number", { filter: { sources: ["engine", 1] }, limit: 10 }],
		["categories that are an object", { filter: { categories: {} }, limit: 10 }],
		["text that is a number", { filter: { text: 5 }, limit: 10 }],
		["terms that are text", { filter: { terms: "a:b" }, limit: 10 }],
		["a term that is text", { filter: { terms: ["a:b"] }, limit: 10 }],
		[
			"a term with no exact flag",
			{ filter: { terms: [{ field: "a", value: "b" }] }, limit: 10 },
		],
		["a cursor that is text", { filter: {}, limit: 10, before: "x" }],
		["a cursor with no files", { filter: {}, limit: 10, before: {} }],
		["a cursor whose files are not a list", { filter: {}, limit: 10, before: { files: {} } }],
		["a cursor entry that is text", { filter: {}, limit: 10, before: { files: ["x"] } }],
		[
			"a cursor name that is a number",
			{ filter: {}, limit: 10, before: { files: [{ name: 1, id: "", offset: 0 }] } },
		],
		[
			"a cursor id that is missing",
			{ filter: {}, limit: 10, before: { files: [{ name: "a", offset: 0 }] } },
		],
		[
			"a cursor offset that is text",
			{
				filter: {},
				limit: 10,
				before: { files: [{ name: "engine_20261118_100000.log", id: "", offset: "0" }] },
			},
		],
		["`around` that is a number", { filter: {}, limit: 10, around: 5 }],
		["an `after` cursor that is text", { filter: {}, limit: 10, after: "x" }],
		[
			"an `after` cursor offset that is text",
			{
				filter: {},
				limit: 10,
				after: { files: [{ name: "engine_20261118_100000.log", id: "", offset: "0" }] },
			},
		],
	])("is refused on logs:read: %s", async (_name, payload) => {
		await expect(ipc.invoke(LOGS_READ_CHANNEL, fakeSender(1).event, payload)).rejects.toThrow(
			/^Refused: a log request /
		);
	});

	it.each<[string, unknown]>([
		["no filter", undefined],
		["a filter that is text", "engine"],
		["sources that are not text", { sources: [1] }],
		["a minimum level that is not one", { minLevel: "verbose" }],
	])("is refused on logs:tail-start: %s", async (_name, filter) => {
		await expect(
			ipc.invoke(LOGS_TAIL_START_CHANNEL, fakeSender(1).event, filter)
		).rejects.toThrow(/^Refused: a log request /);

		expect(clock.scheduled()).toBe(0);
	});

	it.each([
		["a path", "../../etc/passwd"],
		["a path to a log file", `${dir}/engine_20261118_100000.log`],
		["a name with a separator", "engine_20261118_100000.log/../../x"],
		["a file that is no log", "notes.txt"],
	])("never reaches the disk as %s in a cursor", async (_name, name) => {
		await expect(
			ipc.invoke(LOGS_READ_CHANNEL, fakeSender(1).event, {
				filter: {},
				limit: 10,
				before: { files: [{ name, id: "", offset: 5 }] },
			})
		).rejects.toThrow(/Not a log file name/);
	});

	it.each<[string, Record<string, unknown>]>([
		["a cursor with a time to jump to", { before: OK_CURSOR, around: record(1, "x", "y").ts }],
		["a forward and a backward cursor", { after: OK_CURSOR, before: OK_CURSOR }],
		[
			"a forward cursor with a time to jump to",
			{ after: OK_CURSOR, around: record(1, "x", "y").ts },
		],
	])("passes the reader's own refusals through: %s", async (_name, anchors) => {
		await expect(
			ipc.invoke(LOGS_READ_CHANNEL, fakeSender(1).event, {
				filter: {},
				limit: 10,
				...anchors,
			})
		).rejects.toThrow(/one of `before`, `around` or `after`/);
	});

	it("keeps only the keys a filter has, so nothing else reaches the reader", async () => {
		const window = fakeSender(1);

		await ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, {
			categories: ["http"],
			scanBudgetBytes: 1,
			chunkBytes: 1,
		});
		appendFileSync(logFile, line(record(2, "http", "kept")));
		await clock.poll();

		expect(window.batches().flatMap((batch) => batch.records)).toEqual([
			expect.objectContaining({ msg: "kept" }),
		]);
	});
});

describe("logs:tail-start", () => {
	it("pushes the matching records appended after the start to the window that asked", async () => {
		const asker = fakeSender(1);
		const other = fakeSender(2);
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, asker.event, { categories: ["http"] });
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, other.event, { minLevel: "error" });

		appendFileSync(
			logFile,
			line(record(2, "http", "a request")) + line(record(3, "db", "a failure", "error"))
		);
		await clock.poll();

		expect(asker.sender.send).toHaveBeenCalledTimes(1);
		expect(asker.sender.send).toHaveBeenCalledWith(LOGS_RECORDS_CHANNEL, {
			records: [expect.objectContaining({ msg: "a request" })],
			dropped: 0,
		});
		expect(other.sender.send).toHaveBeenCalledTimes(1);
		expect(other.sender.send).toHaveBeenCalledWith(LOGS_RECORDS_CHANNEL, {
			records: [expect.objectContaining({ msg: "a failure" })],
			dropped: 0,
		});
	});

	it("does not deliver what the file held when the tail began", async () => {
		const window = fakeSender(1);
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, {});

		await clock.poll();

		expect(window.sender.send).not.toHaveBeenCalled();
	});

	it("replaces the window's tail when it starts a second", async () => {
		const window = fakeSender(1);
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, { categories: ["http"] });
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, { categories: ["db"] });

		appendFileSync(
			logFile,
			line(record(2, "http", "a request")) + line(record(3, "db", "a write"))
		);
		await clock.poll();

		expect(clock.scheduled()).toBe(1);
		expect(window.batches()).toEqual([
			{ records: [expect.objectContaining({ msg: "a write" })], dropped: 0 },
		]);
	});

	it("keeps the running tail when the replacement is malformed", async () => {
		const window = fakeSender(1);
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, {});
		await expect(
			ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, { sources: 3 })
		).rejects.toThrow();

		appendFileSync(logFile, line(record(2, "http", "still here")));
		await clock.poll();

		expect(window.batches()).toHaveLength(1);
	});

	it("keeps one tail when two starts overlap", async () => {
		const window = fakeSender(1);

		await Promise.all([
			ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, { categories: ["http"] }),
			ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, { categories: ["db"] }),
		]);
		appendFileSync(
			logFile,
			line(record(2, "http", "a request")) + line(record(3, "db", "a write"))
		);
		await clock.poll();

		expect(clock.scheduled()).toBe(1);
		expect(window.batches()).toEqual([
			{ records: [expect.objectContaining({ msg: "a write" })], dropped: 0 },
		]);
	});

	it("keeps no tail when a stop lands while the start is opening files", async () => {
		const window = fakeSender(1);

		await Promise.all([
			ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, {}),
			ipc.invoke(LOGS_TAIL_STOP_CHANNEL, window.event),
		]);

		expect(clock.scheduled()).toBe(0);
	});
});

describe("a tail ends", () => {
	it("on logs:tail-stop, for that window only", async () => {
		const stopped = fakeSender(1);
		const running = fakeSender(2);
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, stopped.event, {});
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, running.event, {});

		await ipc.invoke(LOGS_TAIL_STOP_CHANNEL, stopped.event);
		appendFileSync(logFile, line(record(2, "http", "later")));
		await clock.poll();

		expect(clock.scheduled()).toBe(1);
		expect(stopped.sender.send).not.toHaveBeenCalled();
		expect(running.sender.send).toHaveBeenCalledTimes(1);
	});

	it("when logs:tail-stop comes with no tail running", async () => {
		await expect(
			ipc.invoke(LOGS_TAIL_STOP_CHANNEL, fakeSender(1).event)
		).resolves.toBeUndefined();
	});

	it("when its window is destroyed", async () => {
		const window = fakeSender(1);
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, {});

		window.destroy();

		expect(clock.scheduled()).toBe(0);
	});

	it("when its window's main frame starts a new page", async () => {
		const window = fakeSender(1);
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, {});

		window.navigate({ isMainFrame: true, isSameDocument: false });

		expect(clock.scheduled()).toBe(0);
	});

	it.each<[string, NavigationDetails]>([
		["a subframe", { isMainFrame: false, isSameDocument: false }],
		["a same-document navigation", { isMainFrame: true, isSameDocument: true }],
	])("not for %s", async (_name, details) => {
		const window = fakeSender(1);
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, window.event, {});

		window.navigate(details);

		expect(clock.scheduled()).toBe(1);
	});

	it("starts again after the window was destroyed and a new one has the same id", async () => {
		const first = fakeSender(1);
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, first.event, {});
		first.destroy();

		const second = fakeSender(1);
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, second.event, {});
		appendFileSync(logFile, line(record(2, "http", "to the new one")));
		await clock.poll();

		expect(first.sender.send).not.toHaveBeenCalled();
		expect(second.sender.send).toHaveBeenCalledTimes(1);
	});

	it("when the app quits, for every window, including a start still opening files", async () => {
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, fakeSender(1).event, {});
		await ipc.invoke(LOGS_TAIL_START_CHANNEL, fakeSender(2).event, {});
		const opening = ipc.invoke(LOGS_TAIL_START_CHANNEL, fakeSender(3).event, {});

		registered.stopAll();
		await opening;

		expect(clock.scheduled()).toBe(0);
	});
});
