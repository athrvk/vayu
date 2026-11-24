/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ConsoleLevel } from "@/types";

/**
 * The levels the table draws: a script's `console.*` levels, and `debug`, a log record's lowest
 * level (`LogFileRecord["level"]`) with no `console` call.
 */
export type ToneLevel = ConsoleLevel | "debug";

/**
 * How each level is drawn, one table for the Console tab's script log, an element row's console
 * sample (#3127) and the Logs tab's records (#3635), so a `warn` is one colour everywhere. `log`
 * and `info` share the plain foreground, as Chrome does: a fourth saturated tone in a slab already
 * carrying a section colour would compete with it. The gutter label separates them, which also
 * keeps this from being colour-only (`warn` against `error` in a desaturated accent scheme being
 * the failure the tab indicator avoids). `log`'s gutter is blank: the word on every ordinary line
 * would be noise, and the reserved column keeps messages aligned.
 */
export const LEVEL_TONE: Record<ToneLevel, { gutter: string; text: string; label: string }> = {
	// Muted text as well as label: debug is what a quiet reader scrolls past, and most records
	// carry it.
	debug: { gutter: "debug", text: "text-muted-foreground", label: "text-muted-foreground" },
	log: { gutter: "", text: "text-foreground", label: "text-muted-foreground" },
	info: { gutter: "info", text: "text-foreground", label: "text-muted-foreground" },
	warn: { gutter: "warn", text: "text-status-warning-text", label: "text-status-warning-text" },
	error: { gutter: "error", text: "text-status-error-text", label: "text-status-error-text" },
};
