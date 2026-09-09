/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The main-process half of the renderer -> app log path (#1558): the shape
 * validation nothing on the wire can be trusted to have followed, the pid
 * rewrite, the per-second rate cap, and the Open logs folder handler.
 */

import { describe, it, expect, vi } from "vitest";
import { registerLogIpc, RateLimiter } from "./log-ipc";
import type { Logger, LogLevel } from "./log";

function fakeLogger(): Logger & { calls: [string, string, unknown][] } {
	const calls: [string, string, unknown][] = [];
	const record = (level: LogLevel) => (cat: string, msg: string, fields?: unknown) => {
		calls.push([cat, msg, fields]);
		void level;
	};
	return {
		calls,
		debug: record("debug"),
		info: record("info"),
		warn: record("warn"),
		error: record("error"),
		applyFloor: vi.fn(),
	};
}

/** A minimal `ipcMain`-shaped fake that captures the two registered handlers. */
type FakeSender = { sender: { id: number; getOSProcessId?: () => number } };

function fakeIpc() {
	let logRecordHandler: ((event: FakeSender, ...args: unknown[]) => void) | null = null;
	let openLogsFolderHandler: ((event: unknown, ...args: unknown[]) => unknown) | null = null;
	const ipc = {
		on: (channel: string, fn: (event: FakeSender, ...args: unknown[]) => void) => {
			if (channel === "log:record") logRecordHandler = fn;
		},
		handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
			if (channel === "app:openLogsFolder") openLogsFolderHandler = fn;
		},
	};
	return {
		ipc,
		send: (event: FakeSender, record: unknown) => logRecordHandler?.(event, record),
		openLogsFolder: (event: unknown = {}) => openLogsFolderHandler?.(event),
	};
}

const sender = (id: number) => ({ sender: { id } });

describe("registerLogIpc - log:record validation", () => {
	it("forwards a valid renderer record at its own level", () => {
		const rendererLog = fakeLogger();
		const appLog = fakeLogger();
		const { ipc, send } = fakeIpc();
		registerLogIpc(ipc, { rendererLog, appLog, logsPath: () => "/logs" });

		send(sender(1), { level: "warn", cat: "renderer", msg: "something broke" });

		expect(rendererLog.calls).toHaveLength(1);
		expect(rendererLog.calls[0][0]).toBe("renderer");
		expect(rendererLog.calls[0][1]).toBe("something broke");
	});

	it("ignores a record with an unknown level", () => {
		const rendererLog = fakeLogger();
		const appLog = fakeLogger();
		const { ipc, send } = fakeIpc();
		registerLogIpc(ipc, { rendererLog, appLog, logsPath: () => "/logs" });

		send(sender(1), { level: "critical", cat: "renderer", msg: "x" });

		expect(rendererLog.calls).toHaveLength(0);
	});

	it("ignores a record whose cat is outside the renderer's schema branch", () => {
		const rendererLog = fakeLogger();
		const appLog = fakeLogger();
		const { ipc, send } = fakeIpc();
		registerLogIpc(ipc, { rendererLog, appLog, logsPath: () => "/logs" });

		// "sidecar" is a real category - just not one src:"renderer" is allowed.
		send(sender(1), { level: "info", cat: "sidecar", msg: "x" });

		expect(rendererLog.calls).toHaveLength(0);
	});

	it("ignores a non-object payload rather than throwing", () => {
		const rendererLog = fakeLogger();
		const appLog = fakeLogger();
		const { ipc, send } = fakeIpc();
		registerLogIpc(ipc, { rendererLog, appLog, logsPath: () => "/logs" });

		expect(() => send(sender(1), "not a record")).not.toThrow();
		expect(rendererLog.calls).toHaveLength(0);
	});

	it("carries err and fields through, with pid stamped from the sender", () => {
		const rendererLog = fakeLogger();
		const appLog = fakeLogger();
		const { ipc, send } = fakeIpc();
		registerLogIpc(ipc, { rendererLog, appLog, logsPath: () => "/logs" });

		send(
			{ sender: { id: 7, getOSProcessId: () => 4242 } },
			{
				level: "error",
				cat: "boundary",
				msg: "component threw",
				err: { name: "Error", message: "boom", stack: "at X" },
				fields: { component: "ErrorBoundary" },
			}
		);

		const [, , fields] = rendererLog.calls[0] as [string, string, Record<string, unknown>];
		expect(fields).toMatchObject({
			component: "ErrorBoundary",
			err: { name: "Error", message: "boom", stack: "at X" },
			pid: 4242,
		});
	});

	it("falls back to the sender's webContents id when getOSProcessId is absent", () => {
		const rendererLog = fakeLogger();
		const appLog = fakeLogger();
		const { ipc, send } = fakeIpc();
		registerLogIpc(ipc, { rendererLog, appLog, logsPath: () => "/logs" });

		send(sender(9), { level: "info", cat: "renderer", msg: "x" });

		const [, , fields] = rendererLog.calls[0] as [string, string, Record<string, unknown>];
		expect(fields.pid).toBe(9);
	});
});

describe("registerLogIpc - the per-second cap", () => {
	// Mutation check: revert the RateLimiter's `warned` latch (warn on every
	// over-limit call again) and this test's second assertion reds - the app
	// log would carry 5 warnings instead of 1 for the same burst.
	it("drops the 21st record with one warning, and every later one in the window silently", () => {
		const rendererLog = fakeLogger();
		const appLog = fakeLogger();
		const { ipc, send } = fakeIpc();
		registerLogIpc(ipc, { rendererLog, appLog, logsPath: () => "/logs" });

		for (let i = 0; i < 25; i++) {
			send(sender(1), { level: "info", cat: "renderer", msg: `record ${i}` });
		}

		expect(rendererLog.calls).toHaveLength(20);
		expect(appLog.calls).toHaveLength(1);
		expect(appLog.calls[0][1]).toContain("Dropping renderer log records");
	});

	it("tracks the cap per sender, so one sender's burst does not touch another's", () => {
		const rendererLog = fakeLogger();
		const appLog = fakeLogger();
		const { ipc, send } = fakeIpc();
		registerLogIpc(ipc, { rendererLog, appLog, logsPath: () => "/logs" });

		for (let i = 0; i < 25; i++) send(sender(1), { level: "info", cat: "renderer", msg: "x" });
		for (let i = 0; i < 5; i++) send(sender(2), { level: "info", cat: "renderer", msg: "y" });

		// Sender 1's capped burst (20) plus sender 2's untouched 5.
		expect(rendererLog.calls).toHaveLength(25);
		expect(appLog.calls).toHaveLength(1);
	});

	it("opens a fresh window a second later, resetting the count and the warned latch", () => {
		const rendererLog = fakeLogger();
		const appLog = fakeLogger();
		let clock = 0;
		const { ipc, send } = fakeIpc();
		registerLogIpc(ipc, {
			rendererLog,
			appLog,
			logsPath: () => "/logs",
			rateLimiter: new RateLimiter(() => clock),
		});

		for (let i = 0; i < 25; i++) send(sender(1), { level: "info", cat: "renderer", msg: "x" });
		expect(rendererLog.calls).toHaveLength(20);
		expect(appLog.calls).toHaveLength(1);

		clock += 1000;
		for (let i = 0; i < 25; i++) send(sender(1), { level: "info", cat: "renderer", msg: "x" });

		expect(rendererLog.calls).toHaveLength(40);
		expect(appLog.calls).toHaveLength(2);
	});
});

describe("registerLogIpc - Open logs folder", () => {
	it("opens the logs directory and resolves with the empty string on success", async () => {
		const shellApi = { openPath: vi.fn().mockResolvedValue("") };
		const { ipc, openLogsFolder } = fakeIpc();
		registerLogIpc(ipc, {
			rendererLog: fakeLogger(),
			appLog: fakeLogger(),
			logsPath: () => "/data/logs",
			shellApi,
		});

		const result = await openLogsFolder();

		expect(shellApi.openPath).toHaveBeenCalledWith("/data/logs");
		expect(result).toBe("");
	});

	it("passes the failure reason through unchanged", async () => {
		const shellApi = { openPath: vi.fn().mockResolvedValue("No file manager is configured") };
		const { ipc, openLogsFolder } = fakeIpc();
		registerLogIpc(ipc, {
			rendererLog: fakeLogger(),
			appLog: fakeLogger(),
			logsPath: () => "/data/logs",
			shellApi,
		});

		await expect(openLogsFolder()).resolves.toBe("No file manager is configured");
	});
});
