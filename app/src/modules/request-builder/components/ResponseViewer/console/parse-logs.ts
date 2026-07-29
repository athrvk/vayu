/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which script a console line came from.
 *
 * The engine runs the pre-request and test scripts in one QuickJS context and
 * returns their `console.log` output as one flat array, prefixing the
 * pre-request ones with `"[pre] "`. Splitting them back apart is a string
 * operation, and it was inline in the component - so the cases below were only
 * reachable by rendering the Console tab and reading its sections.
 *
 * The prefix is the engine's, not a user convention, which is what makes this
 * safe to strip: `runtime/` writes it on every pre-request line and nothing
 * else does.
 */

export type LogSource = "pre" | "test";

export interface ParsedLog {
	source: LogSource;
	message: string;
}

/** What the engine prefixes a pre-request line with. */
const PRE_PREFIX = "[pre] ";

export function parseConsoleLogs(logs: string[]): ParsedLog[] {
	return logs.map((log) =>
		log.startsWith(PRE_PREFIX)
			? { source: "pre", message: log.slice(PRE_PREFIX.length) }
			: { source: "test", message: log }
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
