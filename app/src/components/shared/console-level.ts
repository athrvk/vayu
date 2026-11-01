/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ConsoleLevel } from "@/types";

/**
 * How each `console.*` level is drawn - the Console tab's script log and an
 * element row's console sample (#3127) read this one table, so a `warn` is the
 * same colour wherever it prints.
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
export const LEVEL_TONE: Record<ConsoleLevel, { gutter: string; text: string; label: string }> = {
	log: { gutter: "", text: "text-foreground", label: "text-muted-foreground" },
	info: { gutter: "info", text: "text-foreground", label: "text-muted-foreground" },
	warn: { gutter: "warn", text: "text-status-warning-text", label: "text-status-warning-text" },
	error: { gutter: "error", text: "text-status-error-text", label: "text-status-error-text" },
};
