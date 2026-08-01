/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Normalising the engine's console output into what the panel renders.
 *
 * The engine sends one entry per line carrying the script that wrote it and the
 * `console.*` method that was called - `{source, level, message}`. Both used to
 * be missing: the source was a `"[pre] "` text prefix, indistinguishable from a
 * script logging that string itself, and the level was discarded at the QuickJS
 * binding, so every line reached this panel looking identical whether the
 * script called `log` or `error`.
 *
 * A bare string is still accepted, because a renderer can be talking to an
 * older engine sidecar. It is decoded the way that engine meant it - the prefix
 * picks the source, and the level is `log`, which is what the panel drew
 * everything as anyway.
 */

import type { ConsoleLevel, ConsoleLogEntry, ConsoleLogSource } from "@/types";

export type LogSource = ConsoleLogSource;

export interface ParsedLog {
	source: LogSource;
	level: ConsoleLevel;
	message: string;
}

/** What a pre-structured engine prefixed a pre-request line with. */
const PRE_PREFIX = "[pre] ";

const LEVELS: ReadonlySet<string> = new Set<ConsoleLevel>(["log", "info", "warn", "error"]);

/**
 * An unrecognised level reads as `log` rather than being dropped.
 *
 * A line the panel refuses to draw is worse than one drawn in the plain tone,
 * and an unheard-of level is exactly what a *newer* engine would send.
 */
function coerceLevel(level: unknown): ConsoleLevel {
	return typeof level === "string" && LEVELS.has(level) ? (level as ConsoleLevel) : "log";
}

/** The pre-structured shape: source in a prefix, no level. */
function fromLegacyString(log: string): ParsedLog {
	return log.startsWith(PRE_PREFIX)
		? { source: "pre", level: "log", message: log.slice(PRE_PREFIX.length) }
		: { source: "test", level: "log", message: log };
}

export function parseConsoleLogs(logs: Array<ConsoleLogEntry | string>): ParsedLog[] {
	return logs.map((log) =>
		typeof log === "string"
			? fromLegacyString(log)
			: {
					source: log.source === "pre" ? "pre" : "test",
					level: coerceLevel(log.level),
					// `console.log()` with no argument is a real thing a script does,
					// and a vanished line is worse than a blank one.
					message: typeof log.message === "string" ? log.message : "",
				}
	);
}

/**
 * Splits parsed logs into the two sections the panel renders.
 *
 * Returned as a pair rather than filtered twice at the call site, because the
 * two filters and the two sections drifting apart is exactly the shape this
 * file exists to prevent.
 */
export function splitBySource(parsed: ParsedLog[]): Record<LogSource, ParsedLog[]> {
	return {
		pre: parsed.filter((l) => l.source === "pre"),
		test: parsed.filter((l) => l.source === "test"),
	};
}
