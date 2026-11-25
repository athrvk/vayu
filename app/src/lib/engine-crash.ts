/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { CrashEndedRun, EngineCrash } from "@/stores/engine-store";
import { RUN_TYPE_NAME } from "@/modules/history/types";

/** How many of the engine's last stderr lines the Dock quotes. */
const STDERR_LINES_SHOWN = 3;

/**
 * What happened to the engine's process: a failure to run named by its message, a kill by its
 * signal, an exit by its code. The record can hold all three; the most telling comes first.
 */
export function describeEngineCrash(crash: EngineCrash): string {
	if (crash.error !== null) return `Vayu's engine reported an error - ${crash.error}`;
	if (crash.signal !== null) return `Vayu's engine was stopped by signal ${crash.signal}.`;
	if (crash.code !== null) return `Vayu's engine exited with code ${crash.code}.`;
	return "Vayu's engine exited unexpectedly.";
}

/**
 * The tail of what the engine printed before it went, which is usually the
 * reason the code and signal only point at. Empty when it printed nothing.
 */
export function engineCrashOutput(crash: EngineCrash): string {
	return crash.stderrTail
		.map((line) => line.trimEnd())
		.filter((line) => line !== "")
		.slice(-STDERR_LINES_SHOWN)
		.join("\n");
}

/**
 * The sentence that says a crash ended a run, or `null` when none ended (`crashEndedRuns`, #3605),
 * named from `RUN_TYPE_NAME`, the one table of run kind words. Both kinds can appear: a load test
 * and a collection run are not normally live together, but a load run whose stream was lost still
 * counts as live while a collection run holds the stream.
 */
export function describeCrashEndedRuns(ended: readonly CrashEndedRun[]): string | null {
	const names = [
		ended.includes("load") ? RUN_TYPE_NAME.load : null,
		ended.includes("collection") ? RUN_TYPE_NAME.scenario : null,
	]
		.filter((name) => name !== null)
		.map((name) => name.toLowerCase());
	if (names.length === 0) return null;
	if (names.length === 1) return `The ${names[0]} that was running stopped with it.`;
	return `The ${names.join(" and the ")} that were running stopped with it.`;
}
