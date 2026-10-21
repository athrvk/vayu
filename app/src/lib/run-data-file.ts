/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which data file drove a run (issue #2051), read back out of whichever stored
 * shape names it, how the run read it (issue #2540), and whether that file has
 * changed since.
 *
 * The engine records the keys in four places that differ only in where they
 * sit: a collection run's snapshot keeps them inside its `scenario` block, a
 * load run's snapshot keeps them top level, and the `GET /runs` list row mirrors
 * both under `summary`. Narrowing them here keeps every surface that names the
 * file from writing its own cast over `RunConfigSnapshot`'s index signature.
 *
 * Only a display name is ever stored, never a path, so nothing here can print
 * one. The hash is never printed either: it exists to be compared.
 */

import type { RunConfigSnapshot, RunSummary } from "@/types";
import type { DataFileHashReply } from "@/types/electron";

export interface RunDataFile {
	fileName: string;
	/** SHA-256 hex of the file's bytes when the run read it; absent on a run recorded before hashes. */
	hash?: string;
	/**
	 * Whether the run read the file's numbers as numbers. False for a run that
	 * read them as text and for every run recorded before the flag existed.
	 */
	castNumbers: boolean;
}

/** The suffix a surface appends when the collection's file no longer matches the run's. */
export const DATA_FILE_CHANGED_NOTE = "(file changed since this run)";

/** The suffix for a collection whose remembered file is no longer at its path (#2057). */
export const DATA_FILE_MISSING_NOTE = "(file no longer at that path)";

/** The suffix a surface appends to the name of a file the run read with numbers cast (#2540). */
export const DATA_FILE_CAST_NOTE = "(numbers read as numbers)";

/**
 * The file as one stored block holds it, or null. The one reader of the keys:
 * an empty name is no file, a hash and the reading ride only beside a name, and
 * only `true` reads as cast. Exported for a caller that has already narrowed to
 * the block (`run-scenario.ts`).
 */
export function dataFileFromBlock(source: unknown): RunDataFile | null {
	if (typeof source !== "object" || source === null) return null;
	const { dataFileName, dataFileHash, dataFileCastNumbers } = source as Record<string, unknown>;
	if (typeof dataFileName !== "string" || dataFileName === "") return null;
	return {
		fileName: dataFileName,
		...(typeof dataFileHash === "string" ? { hash: dataFileHash } : {}),
		castNumbers: dataFileCastNumbers === true,
	};
}

/** A run's file name as a surface prints it: the name, and the reading when numbers were cast. */
export function dataFileDisplayName(fileName: string, castNumbers: boolean | undefined): string {
	return castNumbers === true ? `${fileName} ${DATA_FILE_CAST_NOTE}` : fileName;
}

/**
 * The file named by a full run snapshot (`GET /runs/:id`): the `scenario`
 * block first, then the top level. Null for a run that bound no file and for
 * one recorded before the field existed.
 */
export function dataFileFromSnapshot(snapshot: RunConfigSnapshot | undefined): RunDataFile | null {
	return dataFileFromBlock(snapshot?.scenario) ?? dataFileFromBlock(snapshot);
}

/** The same read over a `GET /runs` list row's compact summary. */
export function dataFileFromSummary(summary: RunSummary | undefined): RunDataFile | null {
	return dataFileFromBlock(summary?.scenario) ?? dataFileFromBlock(summary);
}

/**
 * The name a run payload may carry for a picked file, or undefined. The engine
 * refuses a `dataFileName` holding `/` or `\` so that no path is ever stored,
 * and a POSIX file name may legally hold a `\`: such a name is left out (the
 * run still records the hash and row count) rather than failing the run.
 */
export function runDataFileName(fileName: string): string | undefined {
	return /[/\\]/.test(fileName) ? undefined : fileName;
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

/** How the collection's remembered file stands against the file a run read. */
export type DataFileStatus = "changed" | "unchanged" | "missing" | "unknown";

/**
 * Classify the remembered file against a run (#2057). `current` is the latest
 * answer about the file, or undefined when there is none: no remembered
 * location, a hash still in flight, or one that failed for a reason other than
 * the file being gone.
 *
 * A missing file is missing whatever the run recorded - one recorded before
 * hashes still names a file that has moved. Every other verdict needs both
 * hashes, per {@link dataFileChanged}.
 */
export function classifyDataFile(
	runHash: string | undefined,
	current: DataFileHashReply | undefined
): DataFileStatus {
	if (current === undefined) return "unknown";
	if (current.status === "missing") return "missing";
	if (runHash === undefined) return "unknown";
	return dataFileChanged(runHash, current.hash) ? "changed" : "unchanged";
}

/** The suffix a header appends for a status, or "" when there is nothing to say. */
export function dataFileNote(status: DataFileStatus): string {
	if (status === "changed") return ` ${DATA_FILE_CHANGED_NOTE}`;
	if (status === "missing") return ` ${DATA_FILE_MISSING_NOTE}`;
	return "";
}
