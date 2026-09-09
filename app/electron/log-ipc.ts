/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file log-ipc.ts
 * @brief The two IPC channels #1558 adds: `log:record` (renderer -> main,
 *        one-way - the `runs:progress` / `icon:signal` shape - forwarding a
 *        `error-logger.ts` record onto the app's `"renderer"` logger) and
 *        `app:openLogsFolder` (Settings, General's "Open logs folder"
 *        button).
 */

import { shell } from "electron";
import type { Logger, LogLevel, LogFields } from "./log.js";

const KNOWN_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);
const RENDERER_CATEGORIES: ReadonlySet<string> = new Set(["renderer", "boundary"]);
/** A page that throws in a loop leaves at most this many records per second. */
const RECORDS_PER_SECOND = 20;

/** Shape a renderer sends over `log:record` - validated, never trusted. */
export interface RendererLogRecord {
	level: LogLevel;
	cat: string;
	msg: string;
	err?: { name: string; message: string; stack?: string };
	fields?: LogFields;
}

function isRendererLogRecord(value: unknown): value is RendererLogRecord {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.level !== "string" || !KNOWN_LEVELS.has(candidate.level)) return false;
	if (typeof candidate.cat !== "string" || !RENDERER_CATEGORIES.has(candidate.cat)) return false;
	return typeof candidate.msg === "string";
}

/** One sender's per-second record count, so a render loop cannot fill the disk. */
export class RateLimiter {
	private windows = new Map<number, { startedAt: number; count: number; warned: boolean }>();

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Registers one record for @p senderId. Returns `"under"` (deliver it),
	 * `"first-over"` (the 21st in this window - drop it and warn once) or
	 * `"over"` (already warned this window - drop it silently). Distinguishing
	 * the last two is the whole point of the cap: warning on every one of a
	 * loop's thousands of drops would itself fill the disk exactly as fast as
	 * the loop would have.
	 */
	check(senderId: number): "under" | "first-over" | "over" {
		const now = this.now();
		const window = this.windows.get(senderId);
		if (!window || now - window.startedAt >= 1000) {
			this.windows.set(senderId, { startedAt: now, count: 1, warned: false });
			return "under";
		}
		window.count += 1;
		if (window.count <= RECORDS_PER_SECOND) return "under";
		if (window.warned) return "over";
		window.warned = true;
		return "first-over";
	}
}

interface IpcSender {
	sender: { id: number; getOSProcessId?: () => number };
}

interface IpcLike {
	on(channel: string, listener: (event: IpcSender, ...args: unknown[]) => void): unknown;
	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
}

interface ShellLike {
	openPath(targetPath: string): Promise<string>;
}

export function registerLogIpc(
	ipc: IpcLike,
	deps: {
		rendererLog: Logger;
		appLog: Logger;
		logsPath: () => string;
		shellApi?: ShellLike;
		rateLimiter?: RateLimiter;
	}
): void {
	const shellApi = deps.shellApi ?? shell;
	const limiter = deps.rateLimiter ?? new RateLimiter();

	ipc.on("log:record", (event, ...args: unknown[]) => {
		const senderId = event.sender.id;
		const status = limiter.check(senderId);
		if (status === "over") return;
		if (status === "first-over") {
			// The 21st record in the window is where this fires, once - every
			// later drop in the same window is silent, or the warning itself
			// would fill the disk exactly as fast as the loop being capped would.
			deps.appLog.warn("ipc", "Dropping renderer log records over the per-second cap", {
				senderId,
			});
			return;
		}

		const candidate = args[0];
		if (!isRendererLogRecord(candidate)) return;

		const fields: LogFields = { ...candidate.fields };
		if (candidate.err) fields.err = candidate.err;
		fields.pid = event.sender.getOSProcessId?.() ?? senderId;

		deps.rendererLog[candidate.level](candidate.cat, candidate.msg, fields);
	});

	ipc.handle("app:openLogsFolder", async () => {
		return await shellApi.openPath(deps.logsPath());
	});
}
