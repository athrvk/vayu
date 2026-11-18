/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ConsoleLevel } from "@/types";

/**
 * The levels the table draws: a script's `console.*` levels, and `debug`, which
 * is a log record's lowest level (`LogFileRecord["level"]`) and has no `console`
 * counterpart a script can call.
 */
export type ToneLevel = ConsoleLevel | "debug";

/**
 * How each level is drawn - the Console tab's script log, an element row's
 * console sample (#3127) and the Logs tab's records (#3635) read this one table,
 * so a `warn` is the same colour wherever it prints.
 *
 * `log` and `info` share the plain foreground on purpose - that is Chrome's
 * behaviour, and a fourth saturated tone inside a slab that already carries a
 * section colour would compete with it rather than inform. What separates them
 * is the gutter label, which is also what keeps this from being a colour-only
 * distinction: `warn` against `error` in a desaturated accent scheme is the
 * same failure the tab indicator exists to avoid.
 *
 * A blank gutter for `log` rather than the word "log": every ordinary line
 * would carry it, a column of noise saying what the absence of a marker already
 * says. The column is still reserved, so messages stay aligned.
 */
export const LEVEL_TONE: Record<ToneLevel, { gutter: string; text: string; label: string }> = {
	// Muted text as well as a muted label: debug is the volume a quiet reader
	// scrolls past, and it is the level a record carries most of.
	debug: { gutter: "debug", text: "text-muted-foreground", label: "text-muted-foreground" },
	log: { gutter: "", text: "text-foreground", label: "text-muted-foreground" },
	info: { gutter: "info", text: "text-foreground", label: "text-muted-foreground" },
	warn: { gutter: "warn", text: "text-status-warning-text", label: "text-status-warning-text" },
	error: { gutter: "error", text: "text-status-error-text", label: "text-status-error-text" },
};
