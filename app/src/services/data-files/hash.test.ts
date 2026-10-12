/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The picker's half of a data file's content hash (issue #2051). jsdom,
 * because the bytes the picker hashes are a DOM `File` read by a DOM
 * `FileReader`, and Web Crypto has to accept that realm's `ArrayBuffer`.
 * Agreement with the main process's digest is pinned beside the main-process
 * read, in `electron/data-file.test.ts`.
 */

import { describe, it, expect } from "vitest";

import { DATA_FILE_HASH_PATTERN, sha256Hex } from "./hash";

/** The FIPS 180-2 "abc" vector: a digest this codebase did not compute. */
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/** A file's bytes the way the picker gets them. */
function readAsPicker(file: File): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as ArrayBuffer);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

describe("sha256Hex", () => {
	it("answers the published digest, in lowercase hex", async () => {
		const hash = await sha256Hex(new TextEncoder().encode("abc").buffer);
		expect(hash).toBe(ABC_SHA256);
		expect(hash).toMatch(DATA_FILE_HASH_PATTERN);
	});

	it("hashes the bytes a picked file reads as", async () => {
		const picked = await readAsPicker(new File(["abc"], "users.csv"));
		expect(await sha256Hex(picked)).toBe(ABC_SHA256);
	});
});
