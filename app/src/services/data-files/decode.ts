/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Bytes to text, before anything tries to read rows out of them (issue #594).
 *
 * `FileReader.readAsText` decodes as UTF-8 and never says it failed: a
 * Windows-1252 CSV - what Excel writes on Windows unless told otherwise -
 * arrives with U+FFFD replacement characters where the accented names were, and
 * a "Unicode Text" export (UTF-16) arrives as either garbage or NUL-riddled
 * columns. Both parse. Both send the wrong strings to the target, which is the
 * silent-wrong-request failure this whole layer exists to remove.
 *
 * So the file is read as bytes and decoded here, where the BOM can be looked at
 * first. UTF-16 is decoded rather than refused - it is a legitimate export from
 * a program people actually use, and the label `readAsText` would have needed is
 * the one `TextDecoder` takes anyway. Anything else that is not UTF-8 is
 * refused: guessing a legacy code page is a second wrong answer, and the user
 * can re-save as UTF-8 in one step once told that is the problem.
 */

import { DataFileError } from "./errors";

/** What the decoder concluded, so a caller can say it rather than assume it. */
export interface DecodedDataFile {
	text: string;
	/** The encoding used, named the way a user would recognise it. */
	encoding: "UTF-8" | "UTF-16LE" | "UTF-16BE";
}

/** U+FFFD - what a UTF-8 decode emits for a byte sequence it cannot read. */
const REPLACEMENT_CHARACTER = "�";

/**
 * Decode a data file's bytes.
 *
 * Throws `DataFileError` when the bytes are neither UTF-8 nor UTF-16, naming
 * the encoding as the problem so "why are there question marks in my names"
 * does not become a parser bug report.
 */
export function decodeDataFile(bytes: ArrayBuffer): DecodedDataFile {
	const head = new Uint8Array(bytes.slice(0, 2));

	// A UTF-16 BOM is the only reliable signal here. A BOM-less UTF-16 file is
	// indistinguishable from binary without heuristics, and it falls into the
	// not-UTF-8 refusal below, which is the honest answer for it.
	if (head[0] === 0xff && head[1] === 0xfe) {
		return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "UTF-16LE" };
	}
	if (head[0] === 0xfe && head[1] === 0xff) {
		return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "UTF-16BE" };
	}

	const text = new TextDecoder("utf-8").decode(bytes);
	if (text.includes(REPLACEMENT_CHARACTER)) {
		throw new DataFileError(
			"The file is not UTF-8 - some bytes could not be decoded, and the values they belong to would be sent with question marks in them. Re-save it as UTF-8 (or as UTF-16 with a byte-order mark) and pick it again."
		);
	}
	return { text, encoding: "UTF-8" };
}
