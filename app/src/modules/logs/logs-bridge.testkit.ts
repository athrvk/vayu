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
 */

import { vi } from "vitest";
import type {
	LogBatch,
	LogEntry,
	LogFileRecord,
	LogFilter,
	LogReadRequest,
	LogReadResult,
} from "@/types/electron";

const NO_MORE: LogReadResult = { records: [], cursor: { files: [] }, more: false, scannedTo: null };

const FIRST_TS = Date.UTC(2026, 10, 18, 10, 0, 0);

/** A record, `ts` one second after the previous @p n, so a list of them is in time order. */
export function logRecord(n: number, overrides: Partial<LogFileRecord> = {}): LogFileRecord {
	return {
		ts: new Date(FIRST_TS + n * 1000).toISOString(),
		level: "info",
		src: "engine",
		cat: "http",
		msg: `line ${n}`,
		pid: 4242,
		...overrides,
	};
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
		/** The answer the next reads give, until it is set again. */
		answer: (result: Partial<LogReadResult>) => {
			logs.read.mockResolvedValue({ ...NO_MORE, ...result });
		},
	};
}

export type FakeLogsBridge = ReturnType<typeof fakeLogsBridge>;
