/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A data file's content hash (issue #2051): the SHA-256 of its raw bytes, as
 * 64 lowercase hex characters - what a run records beside the file's name, so
 * two runs can be told apart by the file that drove them.
 *
 * A file reaches the app two ways and each hashes its own bytes: a re-read of
 * a remembered path is hashed in the main process (`electron/data-file.ts`,
 * Node's `crypto`), a hand-picked file is read by a `FileReader` here and never
 * crosses to main. `electron/data-file.test.ts` holds the two to one digest for
 * one file. The bytes are hashed before any decoding, so a UTF-16 file and its
 * UTF-8 transcoding are two different files, as they are on disk.
 */

/**
 * The digest's shape, for a hash read back from storage. Restated in
 * `electron/data-file.ts`, which the renderer cannot import; the same test
 * holds the two equal.
 */
export const DATA_FILE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** SHA-256 of `bytes`, as 64 lowercase hex characters. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
		""
	);
}
