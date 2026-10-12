/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which data file drove a run (issue #2051), read back out of whichever stored
 * shape names it, and whether that file has changed since.
 *
 * The engine records the pair in four places that differ only in where the key
 * sits: a collection run's snapshot keeps it inside its `scenario` block, a
 * load run's snapshot keeps it top level, and the `GET /runs` list row mirrors
 * both under `summary`. Narrowing them here keeps every surface that names the
 * file from writing its own cast over `RunConfigSnapshot`'s index signature.
 *
 * Only a display name is ever stored, never a path, so nothing here can print
 * one. The hash is never printed either: it exists to be compared.
 */

import type { RunConfigSnapshot, RunSummary } from "@/types";

export interface RunDataFile {
	fileName: string;
	/** SHA-256 hex of the file's bytes when the run read it; absent on a run recorded before hashes. */
	hash?: string;
}

/** The suffix a surface appends when the collection's file no longer matches the run's. */
export const DATA_FILE_CHANGED_NOTE = "(file changed since this run)";

function readPair(source: unknown): RunDataFile | null {
	if (typeof source !== "object" || source === null) return null;
	const { dataFileName, dataFileHash } = source as Record<string, unknown>;
	if (typeof dataFileName !== "string" || dataFileName === "") return null;
	return {
		fileName: dataFileName,
		...(typeof dataFileHash === "string" ? { hash: dataFileHash } : {}),
	};
}

/**
 * The file named by a full run snapshot (`GET /runs/:id`): the `scenario`
 * block first, then the top level. Null for a run that bound no file and for
 * one recorded before the field existed.
 */
export function dataFileFromSnapshot(snapshot: RunConfigSnapshot | undefined): RunDataFile | null {
	return readPair(snapshot?.scenario) ?? readPair(snapshot);
}

/** The same read over a `GET /runs` list row's compact summary. */
export function dataFileFromSummary(summary: RunSummary | undefined): RunDataFile | null {
	return readPair(summary?.scenario) ?? readPair(summary);
}

/**
 * Whether the file the app now remembers for the run's collection differs from
 * the one the run read. Both hashes must be known: a run recorded before hashes
 * existed, or a location remembered before one was read, cannot be compared,
 * and saying "changed" of a file nobody can tell is worse than saying nothing.
 */
export function dataFileChanged(
	runHash: string | undefined,
	rememberedHash: string | undefined
): boolean {
	return runHash !== undefined && rememberedHash !== undefined && runHash !== rememberedHash;
}
