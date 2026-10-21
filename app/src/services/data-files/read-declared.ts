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
 *
 * The row cap is enforced **here**, against the live setting the caller passes
 * in (issue #751). The main-process gate this reads through already refuses the
 * byte cap on the way out (`electron/data-file.ts`), but it deliberately does
 * not parse - the app owns parsing - so it cannot count rows, and without this
 * the remembered path was the one way past a refusal the picker makes on every
 * hand-picked file. `maxRows` is required rather than optional so a fourth
 * surface cannot re-open the hole by omitting it.
 *
 * It is also where the remembered location learns the file's current content
 * hash (issue #2051): every byte read records it against the path, so
 * `data-file-store` (and through it MCP's `list_collections`) carries the
 * digest of the file as the app last saw it rather than as it was first picked.
 * Recorded before decoding, since it describes the bytes on disk whether or not
 * they still parse; it changes no declaration, only what is known about the
 * file the declaration already names.
 */

import { decodeDataFile } from "./decode";
import { DataFileError } from "./errors";
import { describeRowCapRefusal } from "./row-cap";
import { parseDataFile, type ParsedDataFile } from "./index";
import { useDataFileStore } from "@/stores/data-file-store";
import type { DataFileHashReply } from "@/types/electron";

/** A file re-read from disk, in the shape the pickers already hold. */
export interface DeclaredDataFile {
	/** The name on disk, which is the main process's answer and not the stored one. */
	fileName: string;
	parsed: ParsedDataFile;
	/** The decoded text, so a change of reading re-parses what was previewed. */
	text: string;
	/** The path it was read from, so a caller can remember it unchanged. */
	path: string;
	/** SHA-256 of the bytes read, 64 lowercase hex: what a run records (#2051). */
	hash: string;
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
 * Whether this build can hash a remembered path without reading it (#2051).
 * Separate from {@link canReadDeclaredDataFile} because a caller falls back to
 * the stored hash when it cannot, rather than to nothing.
 */
export function canHashDeclaredDataFile(): boolean {
	return typeof window.electronAPI?.hashDataFile === "function";
}

/**
 * The SHA-256 hex of the file at `path` as it is now, the digest a re-read
 * would answer, without its bytes crossing to the renderer. A file that has
 * moved resolves `{ status: "missing" }` (#2057); it rejects with
 * `NoDataFileBridgeError` outside Electron and with the main process's message
 * when the request is refused (extension, empty path). It records nothing in
 * `data-file-store`, whose hash stays the one the app last read the file with.
 */
export async function hashDeclaredDataFile(path: string): Promise<DataFileHashReply> {
	const hash = window.electronAPI?.hashDataFile;
	if (!hash) throw new NoDataFileBridgeError();
	return await hash(path);
}

/** How a re-read is parsed, and what it has to be measured against. */
export interface DeclaredDataFileOptions {
	/**
	 * The live `maxScenarioDataRows`, from {@link useDataFileLimits}. Never a
	 * constant: a user who raises the setting must get the file on the next
	 * re-read, without restarting anything.
	 */
	maxRows: number;
	/**
	 * The binding's `castNumbers` (#2540). Required for the same reason as
	 * `maxRows`: a caller that omitted it would read the file as text while the
	 * picker, with the same file, read numbers.
	 */
	castNumbers: boolean;
}

/**
 * Read, decode and parse the file at `path` the way its binding reads it,
 * refusing a set over `maxRows`.
 *
 * Rejects with `NoDataFileBridgeError` outside Electron, and with
 * `DataFileError` (or whatever the bridge threw) when the file is gone, moved,
 * no longer parses, or now carries more rows than a run may - all of which name
 * the fault in a sentence a caller can show as-is.
 */
export async function readDeclaredDataFile(
	path: string,
	{ maxRows, castNumbers }: DeclaredDataFileOptions
): Promise<DeclaredDataFile> {
	const read = window.electronAPI?.readDataFile;
	if (!read) throw new NoDataFileBridgeError();

	const { bytes, fileName, hash } = await read(path);
	useDataFileStore.getState().recordDataFileHash(path, hash);
	// The same decode and the same parser the picker runs, so a file re-read
	// here cannot disagree with the file as it was declared.
	const { text } = decodeDataFile(bytes.buffer as ArrayBuffer);
	const parsed = parseDataFile(text, fileName, { castNumbers });

	// The picker's own refusal, thrown rather than returned: every caller here
	// already shows a failed re-read as a note beside a usable picker, which is
	// the right shape for this too - picking the file again, or raising the
	// setting, is the fix.
	const refusal = describeRowCapRefusal(parsed.rows.length, maxRows);
	if (refusal) throw new DataFileError(refusal);

	return { fileName, parsed, text, path, hash };
}
