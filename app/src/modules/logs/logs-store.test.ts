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
 * `reloadFresh` call in `setControls` and the filter cases red.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { LogEntry, LogReadRequest } from "@/types/electron";
import { entryBytes } from "./log-entry";
import { fakeLogsBridge, logRecord, type FakeLogsBridge } from "./logs-bridge.testkit";
import { LOG_MAX_BYTES, LOG_MAX_RECORDS, buildLogFilter, useLogsStore } from "./logs-store";

let bridge: FakeLogsBridge;

/** Records `from` to `from + count - 1`, oldest first. */
function span(from: number, count: number): LogEntry[] {
	return Array.from({ length: count }, (_, i) => logRecord(from + i));
}

const state = () => useLogsStore.getState();

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
		const big = (n: number) => logRecord(n, { msg: "x".repeat(500_000) });
		bridge.answer({ records: [big(0)] });
		await state().start();

		bridge.push([big(1), big(2), big(3), big(4), big(5), big(6), big(7), big(8)]);
		bridge.push([big(9), big(10), big(11), big(12), big(13), big(14), big(15), big(16)]);
		bridge.push([big(17), big(18), big(19)]);

		expect(state().bytes).toBeLessThanOrEqual(LOG_MAX_BYTES);
		expect(state().bytes).toBe(state().records.reduce((sum, r) => sum + entryBytes(r), 0));
		expect(state().records.length).toBeLessThan(20);
		expect((state().records[state().records.length - 1] as { msg: string }).msg).toHaveLength(
			500_000
		);
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
