/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The engine's console output, normalised for the panel. The engine sends one entry per line with
 * the script and `console.*` method: `{source, scope?, level, message, scriptRequest?}`. A bare
 * string is still accepted, since the renderer may talk to an older engine sidecar: its prefix
 * picks the source, and the level is `log`, as that engine's output was drawn.
 */

import type { ConsoleLevel, ConsoleLogEntry, ElementScope, ScriptSource } from "@/types";

export type LogSource = ScriptSource;

export interface ParsedLog {
	source: LogSource;
	/** The level whose script printed the line (#2522); absent is the request's own. */
	scope?: ElementScope;
	level: ConsoleLevel;
	message: string;
	/** A `pm.sendRequest` summary line's record index (#3633); see `console-rows.ts`. */
	scriptRequest?: number;
}

/** What a pre-structured engine prefixed a pre-request line with. */
const PRE_PREFIX = "[pre] ";

const LEVELS: ReadonlySet<string> = new Set<ConsoleLevel>(["log", "info", "warn", "error"]);

/**
 * An unknown level reads as `log`, never dropped: an undrawn line is worse than a plain one, and a
 * newer engine is what sends one.
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

export function parseConsoleLogs(logs: ReadonlyArray<ConsoleLogEntry | string>): ParsedLog[] {
	return logs.map((log) =>
		typeof log === "string"
			? fromLegacyString(log)
			: {
					source: log.source === "pre" ? "pre" : "test",
					scope: log.scope,
					level: coerceLevel(log.level),
					// `console.log()` with no argument is real, and a vanished line is worse than a
					// blank one.
					message: typeof log.message === "string" ? log.message : "",
					...(typeof log.scriptRequest === "number" && {
						scriptRequest: log.scriptRequest,
					}),
				}
	);
}

/**
 * Parsed logs as the panel's two sections, returned as a pair so the two filters and sections
 * cannot drift.
 */
export function splitBySource<Row extends { source: LogSource }>(
	parsed: readonly Row[]
): Record<LogSource, Row[]> {
	return {
		pre: parsed.filter((l) => l.source === "pre"),
		test: parsed.filter((l) => l.source === "test"),
	};
}
