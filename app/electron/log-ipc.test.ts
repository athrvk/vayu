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

/** Registers the handler, sends one record, and returns what the renderer logger received. */
function forward(record: unknown) {
	const rendererLog = fakeLogger();
	const { ipc, send } = fakeIpc();
	registerLogIpc(ipc, { rendererLog, appLog: fakeLogger(), logsPath: () => "/logs" });
	send(sender(1), record);
	const [call] = rendererLog.calls as [string, string, Record<string, unknown>][];
	return call ? { cat: call[0], msg: call[1], fields: call[2] } : null;
}

const TRUNCATION_MARKER = "...[truncated]";

describe("registerLogIpc - bounding what a renderer sends", () => {
	// Mutation check: delete the `truncate` call in `boundedText` and the msg
	// keeps all 1 MB.
	it("stores a 1 MB msg cut at 2000 characters with the marker", () => {
		const sent = forward({ level: "info", cat: "renderer", msg: "x".repeat(1024 * 1024) });

		expect(sent?.msg).toBe("x".repeat(2000) + TRUNCATION_MARKER);
	});

	it("stores a msg at the cap untouched", () => {
		const sent = forward({ level: "info", cat: "renderer", msg: "x".repeat(2000) });

		expect(sent?.msg).toBe("x".repeat(2000));
	});

	it("cuts err name, message and stack at 200, 2000 and 8000 characters", () => {
		const sent = forward({
			level: "error",
			cat: "boundary",
			msg: "threw",
			err: { name: "n".repeat(500), message: "m".repeat(5000), stack: "s".repeat(20000) },
		});

		expect(sent?.fields.err).toEqual({
			name: "n".repeat(200) + TRUNCATION_MARKER,
			message: "m".repeat(2000) + TRUNCATION_MARKER,
			stack: "s".repeat(8000) + TRUNCATION_MARKER,
		});
	});

	it.each([
		["a string", "boom"],
		["an array", ["Error", "boom"]],
		["a name that is not a string", { name: 1, message: "boom" }],
		["a message that is not a string", { name: "Error", message: {} }],
	])("drops err when it is %s", (_label, err) => {
		const sent = forward({ level: "error", cat: "renderer", msg: "x", err });

		expect(sent).not.toBeNull();
		expect(sent?.fields).not.toHaveProperty("err");
	});

	it.each([
		["a string", "just text"],
		["an array", [{ a: 1 }]],
	])("drops fields when it is %s", (_label, fields) => {
		const sent = forward({ level: "info", cat: "renderer", msg: "x", fields });

		expect(Object.keys(sent?.fields ?? {})).toEqual(["pid"]);
	});

	it("cuts a string field value at 500 characters", () => {
		const sent = forward({
			level: "info",
			cat: "renderer",
			msg: "x",
			fields: { note: "v".repeat(900), count: 3 },
		});

		expect(sent?.fields.note).toBe("v".repeat(500) + TRUNCATION_MARKER);
		expect(sent?.fields.count).toBe(3);
	});

	it("keeps at most 20 field keys", () => {
		const fields = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
		const sent = forward({ level: "info", cat: "renderer", msg: "x", fields });

		expect(Object.keys(sent?.fields ?? {}).filter((key) => key.startsWith("k"))).toHaveLength(
			20
		);
	});

	it("replaces fields serialising past 4000 characters with a truncated marker", () => {
		const fields = Object.fromEntries(
			Array.from({ length: 10 }, (_, i) => [`k${i}`, ["y".repeat(450)]])
		);
		const sent = forward({ level: "info", cat: "renderer", msg: "x", fields });

		expect(sent?.fields).toEqual({ truncated: true, pid: 1 });
	});

	it("replaces fields JSON cannot serialise rather than throwing", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		const sent = forward({ level: "info", cat: "renderer", msg: "x", fields: { cyclic } });

		expect(sent?.fields).toEqual({ truncated: true, pid: 1 });
	});
});

describe("registerLogIpc - URL secrets in renderer text", () => {
	const url = "https://u:p@h/p?code=abc&state=1";

	// Mutation check: replace `boundedText`'s `stripUrlSecretsInText(text)` with
	// `text` and the stack, msg and field assertions below all keep the secret.
	it("strips credentials from an err stack, msg and string field", () => {
		const sent = forward({
			level: "error",
			cat: "renderer",
			msg: `fetch failed for ${url}`,
			err: {
				name: "Error",
				message: `bad ${url}`,
				stack: `Error: bad\n    at ${url} (app.js:1)`,
			},
			fields: { target: url },
		});

		expect(sent?.msg).toBe("fetch failed for https://h/p");
		expect(sent?.fields.err).toEqual({
			name: "Error",
			message: "bad https://h/p",
			stack: "Error: bad\n    at https://h/p (app.js:1)",
		});
		expect(sent?.fields.target).toBe("https://h/p");
	});
});

describe("registerLogIpc - keys the logger owns", () => {
	// Mutation check: delete the RESERVED_FIELD_KEYS loop in the handler and
	// the renderer's `src`, `msg` and `cat` overwrite the record's own.
	it("drops reserved renderer fields, so the record keeps its real values", () => {
		const rendererLog = fakeLogger();
		const { ipc, send } = fakeIpc();
		registerLogIpc(ipc, { rendererLog, appLog: fakeLogger(), logsPath: () => "/logs" });

		send(sender(1), {
			level: "info",
			cat: "renderer",
			msg: "real",
			fields: {
				ts: "1970",
				level: "debug",
				src: "engine",
				cat: "y",
				msg: "x",
				tid: 5,
				component: "kept",
			},
		});

		const [cat, msg, fields] = rendererLog.calls[0] as [
			string,
			string,
			Record<string, unknown>,
		];
		expect([cat, msg]).toEqual(["renderer", "real"]);
		expect(fields).toEqual({ component: "kept", pid: 1 });
	});

	it("still overrides a renderer-supplied pid with the sender's", () => {
		const sent = forward({ level: "info", cat: "renderer", msg: "x", fields: { pid: 999 } });
		expect(sent?.fields.pid).toBe(1);
	});
});

describe("registerLogIpc - console safety", () => {
	// Mutation check: delete the CONTROL_CHARACTERS replace and the msg keeps
	// its newlines, which the console prints as separate lines.
	it("turns control characters in msg into spaces so it stays on one console line", () => {
		const sent = forward({
			level: "info",
			cat: "renderer",
			msg: "one\n12:00:00.000 ERROR   main     forged\r\ttab\u0000",
		});

		expect(sent?.msg).toBe("one 12:00:00.000 ERROR   main     forged  tab ");
		expect([...(sent?.msg ?? "")].some((char) => char.charCodeAt(0) < 0x20)).toBe(false);
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
