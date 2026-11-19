/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The session Console's ring (#3634): two bounds, oldest out first, the newest
 * kept, a body cut on the way in, and a count of what was dropped.
 *
 * Mutation check: drop the eviction loop in `withAppended` and "holds at most
 * CONSOLE_MAX_ROWS rows" and "holds at most CONSOLE_MAX_BYTES" fail, the row
 * count growing past the bound; drop its `rows.length - dropped > 1` guard and
 * "keeps the newest row" fails; drop `withBodiesCut` and "cuts a body" fails;
 * drop the `runKeys.has` skip and "appends a step frame once" fails.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	CONSOLE_BODY_MAX_CHARS,
	CONSOLE_MAX_BYTES,
	CONSOLE_MAX_ROWS,
	estimateConsoleRowBytes,
	useConsoleStore,
	type ConsoleLineRow,
	type ConsoleRowInput,
	type ConsoleSendRow,
	type ConsoleStepRow,
} from "./console-store";

beforeEach(() => {
	useConsoleStore.getState().clear();
});

const line = (message: string): ConsoleLineRow => ({
	kind: "line",
	source: "pre",
	level: "log",
	message,
});

const send = (body: string): ConsoleSendRow => ({
	kind: "send",
	method: "POST",
	url: "https://api.test/u",
	status: 200,
	timeMs: 3,
	sizeBytes: body.length,
	exchange: { requestHeaders: {}, responseHeaders: {}, responseBody: { text: body } },
});

const step = (iteration: number, stepIndex: number, runId = "run_1"): ConsoleStepRow => ({
	kind: "step",
	runId,
	iteration,
	stepIndex,
	name: `step ${stepIndex}`,
	outcome: "passed",
	status: 200,
	timeMs: 4,
});

const append = (rows: ConsoleRowInput[]) => useConsoleStore.getState().append(rows);
const state = () => useConsoleStore.getState();
const last = () => state().rows[state().rows.length - 1];
const messages = () => state().rows.map((row) => (row.kind === "line" ? row.message : row.kind));

describe("the row bound", () => {
	it("holds at most CONSOLE_MAX_ROWS rows, evicting the oldest first", () => {
		append(Array.from({ length: CONSOLE_MAX_ROWS + 3 }, (_, i) => line(`m${i}`)));

		expect(state().rows).toHaveLength(CONSOLE_MAX_ROWS);
		expect(messages()[0]).toBe("m3");
		expect(messages()[messages().length - 1]).toBe(`m${CONSOLE_MAX_ROWS + 2}`);
		expect(state().evictedCount).toBe(3);
	});

	it("counts evictions across appends, and keeps the ids rising", () => {
		append(Array.from({ length: CONSOLE_MAX_ROWS }, (_, i) => line(`m${i}`)));
		append([line("next")]);
		append([line("last")]);

		expect(state().evictedCount).toBe(2);
		const ids = state().rows.map((row) => row.id);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("the byte bound", () => {
	// Each body is just under the cut, so the bound is reached on bytes alone,
	// far below the row bound: 2 bytes a code unit, 64 rows is 32 MiB.
	const big = "x".repeat(CONSOLE_BODY_MAX_CHARS - 1);

	it("holds at most CONSOLE_MAX_BYTES of retained text, oldest out first", () => {
		const rows = Array.from({ length: 70 }, () => send(big));
		for (const row of rows) append([row]);

		expect(state().retainedBytes).toBeLessThanOrEqual(CONSOLE_MAX_BYTES);
		expect(state().rows.length).toBeLessThan(70);
		expect(state().evictedCount).toBe(70 - state().rows.length);
		const total = state().rows.reduce((sum, row) => sum + estimateConsoleRowBytes(row), 0);
		expect(state().retainedBytes).toBe(total);
		// The ids still rise from the front: what went was the oldest.
		expect(state().rows[0].id).toBe(last().id - state().rows.length + 1);
	});

	it("keeps the newest row even when it alone is over the budget", () => {
		append([line("old")]);
		const huge = line("y".repeat(CONSOLE_MAX_BYTES / 2 + 1));
		append([huge]);

		expect(state().rows).toHaveLength(1);
		expect(state().rows[0]).toMatchObject({ kind: "line", message: huge.message });
		expect(state().evictedCount).toBe(1);
	});
});

describe("a body kept on a row", () => {
	it("cuts a body past CONSOLE_BODY_MAX_CHARS and flags it", () => {
		append([send("z".repeat(CONSOLE_BODY_MAX_CHARS + 10))]);

		const row = state().rows[0] as ConsoleSendRow;
		expect(row.exchange.responseBody?.text).toHaveLength(CONSOLE_BODY_MAX_CHARS);
		expect(row.exchange.responseBody?.cut).toBe(true);
		// The size on the row is the response's, not what the ring kept.
		expect(row.sizeBytes).toBe(CONSOLE_BODY_MAX_CHARS + 10);
	});

	it("leaves a body at the limit whole and unflagged", () => {
		append([send("z".repeat(CONSOLE_BODY_MAX_CHARS))]);

		const row = state().rows[0] as ConsoleSendRow;
		expect(row.exchange.responseBody?.text).toHaveLength(CONSOLE_BODY_MAX_CHARS);
		expect(row.exchange.responseBody?.cut).toBeUndefined();
	});

	it("never cuts between the two halves of a surrogate pair", () => {
		const text = "a".repeat(CONSOLE_BODY_MAX_CHARS - 1) + "😀" + "tail";
		append([send(text)]);

		const kept = (state().rows[0] as ConsoleSendRow).exchange.responseBody!.text;
		expect(kept).toHaveLength(CONSOLE_BODY_MAX_CHARS - 1);
		expect(kept.endsWith("a")).toBe(true);
	});
});

describe("run identity", () => {
	it("appends a step frame once, however often it is replayed", () => {
		append([step(0, 0), step(0, 1)]);
		append([step(0, 1), step(0, 2)]);

		expect(state().rows.map((row) => (row as ConsoleStepRow).stepIndex)).toEqual([0, 1, 2]);
	});

	it("tells the same position in two runs apart", () => {
		append([step(0, 0, "run_1"), step(0, 0, "run_2")]);
		expect(state().rows).toHaveLength(2);
	});

	it("appends a streamed Send's run once", () => {
		append([{ ...send("a"), runId: "run_9" }]);
		append([{ ...send("a"), runId: "run_9" }]);
		append([send("a"), send("a")]);

		expect(state().rows).toHaveLength(3);
	});

	it("takes a step back once its row was evicted", () => {
		append([step(0, 0)]);
		append(Array.from({ length: CONSOLE_MAX_ROWS }, (_, i) => line(`m${i}`)));
		append([step(0, 0)]);

		expect(last()).toMatchObject({ kind: "step", stepIndex: 0 });
	});
});

describe("clear", () => {
	it("empties the ring and its counters", () => {
		append([line("a"), step(0, 0)]);
		append(Array.from({ length: CONSOLE_MAX_ROWS }, (_, i) => line(`m${i}`)));
		const lastId = last().id;

		state().clear();
		expect(state().rows).toEqual([]);
		expect(state().retainedBytes).toBe(0);
		expect(state().evictedCount).toBe(0);

		// A cleared step can come back, and ids never repeat.
		append([step(0, 0)]);
		expect(state().rows).toHaveLength(1);
		expect(state().rows[0].id).toBeGreaterThan(lastId);
	});

	it("an empty append writes nothing", () => {
		const before = state();
		append([]);
		expect(state()).toBe(before);
	});
});
