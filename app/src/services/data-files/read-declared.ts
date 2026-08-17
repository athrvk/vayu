/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Re-reading the file a collection declared its contract from (issue #727).
 *
 * `index.ts` is deliberately pure - text in, rows out - and stays that way: the
 * *first* read of a file is a `FileReader` in the picker, driven by a user who
 * just chose it. This module is the other read, the one no click asks for: the
 * path `data-file-store` remembered, opened again through the Electron bridge so
 * a surface can show the file as it is on disk *now*.
 *
 * It exists as one function because three surfaces do it - the Run dialog's
 * pre-fill, Send-with-row, and the Data tab's comparison - and each had (or was
 * about to have) its own copy of bridge-lookup, decode and parse. A copy is how
 * one of them ends up decoding differently from the file as it was declared.
 *
 * The bridge being absent is its own error rather than a failed read, because it
 * is a different answer: a browser has no path to re-read and never will, so the
 * caller shows its degraded state instead of a message inviting a retry that
 * cannot work.
 */

import { decodeDataFile } from "./decode";
import { parseDataFile, type ParsedDataFile } from "./index";

/** A file re-read from disk, in the shape the pickers already hold. */
export interface DeclaredDataFile {
	/** The name on disk, which is the main process's answer and not the stored one. */
	fileName: string;
	parsed: ParsedDataFile;
	/** The path it was read from, so a caller can remember it unchanged. */
	path: string;
}

/**
 * No filesystem to re-read from - a browser, not the desktop app.
 *
 * Separate from a read failure so callers can tell "there is nothing to try"
 * from "this file has moved", which have different repairs.
 */
export class NoDataFileBridgeError extends Error {
	constructor(message = "Reading the declared data file needs the desktop app.") {
		super(message);
		this.name = "NoDataFileBridgeError";
	}
}

/**
 * Whether a remembered path can be re-read at all on this build.
 *
 * Offered separately so a surface can decide *before* it renders a spinner: the
 * browser case is not a pending read, it is a state that will never resolve.
 */
export function canReadDeclaredDataFile(): boolean {
	return typeof window.electronAPI?.readDataFile === "function";
}

/**
 * Read, decode and parse the file at `path`.
 *
 * Rejects with `NoDataFileBridgeError` outside Electron, and with
 * `DataFileError` (or whatever the bridge threw) when the file is gone, moved,
 * or no longer parses - all of which name the fault in a sentence a caller can
 * show as-is.
 */
export async function readDeclaredDataFile(path: string): Promise<DeclaredDataFile> {
	const read = window.electronAPI?.readDataFile;
	if (!read) throw new NoDataFileBridgeError();

	const { bytes, fileName } = await read(path);
	// The same decode and the same parser the picker runs, so a file re-read
	// here cannot disagree with the file as it was declared.
	const { text } = decodeDataFile(bytes.buffer as ArrayBuffer);
	return { fileName, parsed: parseDataFile(text, fileName), path };
}
