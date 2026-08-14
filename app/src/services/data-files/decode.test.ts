/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Decoding a data file's bytes (issue #594). Node env - bytes in, text out.
 *
 * What each case protects is the same thing: the values that reach the target.
 * A Windows-1252 export decoded as UTF-8 sends `Zo�` where the row said
 * `Zoë`, and it parses cleanly, so nothing downstream can catch it.
 */

import { describe, it, expect } from "vitest";

import { DataFileError, decodeDataFile } from "./index";

function utf8(text: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(text);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** UTF-16LE bytes, BOM included, the way an Excel "Unicode Text" export writes. */
function utf16le(text: string): ArrayBuffer {
	const withBom = `\uFEFF${text}`;
	const bytes = new Uint8Array(withBom.length * 2);
	for (let i = 0; i < withBom.length; i++) {
		const code = withBom.charCodeAt(i);
		bytes[i * 2] = code & 0xff;
		bytes[i * 2 + 1] = code >> 8;
	}
	return bytes.buffer as ArrayBuffer;
}

function utf16be(text: string): ArrayBuffer {
	const le = new Uint8Array(utf16le(text));
	const be = new Uint8Array(le.length);
	for (let i = 0; i < le.length; i += 2) {
		be[i] = le[i + 1];
		be[i + 1] = le[i];
	}
	return be.buffer as ArrayBuffer;
}

describe("decodeDataFile", () => {
	it("decodes UTF-8 and says so", () => {
		expect(decodeDataFile(utf8("user,city\nzoe,Köln"))).toEqual({
			text: "user,city\nzoe,Köln",
			encoding: "UTF-8",
		});
	});

	it("re-decodes a UTF-16LE file rather than reading it as garbage", () => {
		const { text, encoding } = decodeDataFile(utf16le("user,id\nada,1"));
		expect(encoding).toBe("UTF-16LE");
		// The BOM goes with the decode - it must not become part of column one.
		expect(text).toBe("user,id\nada,1");
	});

	it("re-decodes a UTF-16BE file too", () => {
		const { text, encoding } = decodeDataFile(utf16be("user\nada"));
		expect(encoding).toBe("UTF-16BE");
		expect(text).toBe("user\nada");
	});

	it("refuses bytes that are not UTF-8, naming the encoding as the problem", () => {
		// `Zoë` as Windows-1252: the 0xEB is not a valid UTF-8 sequence, so a
		// UTF-8 decode silently produces a replacement character.
		const latin1 = new Uint8Array([0x5a, 0x6f, 0xeb]).buffer as ArrayBuffer;
		expect(() => decodeDataFile(latin1)).toThrow(DataFileError);
		expect(() => decodeDataFile(latin1)).toThrow(/not UTF-8/);
	});

	it("keeps a UTF-8 file whose bytes merely look unusual", () => {
		// An emoji is four bytes and decodes cleanly - the refusal is about
		// undecodable bytes, not about anything outside ASCII.
		expect(decodeDataFile(utf8("emoji\n🚀")).text).toBe("emoji\n🚀");
	});
});
