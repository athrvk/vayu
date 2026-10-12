/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The gates on the one channel that lets the renderer name a file path
 * (issue #599).
 *
 * This channel is a deliberate widening of the "the renderer never names paths"
 * posture, so what keeps it narrow is the whole value of the module: an
 * extension allowlist, and the engine's *fetched* byte cap. Both are driven here
 * against an injected filesystem, so a regression in either shows up as a test
 * rather than as a file the app should never have opened.
 */

import { describe, it, expect, vi } from "vitest";
import {
	readDataFile,
	DATA_FILE_EXTENSIONS,
	DATA_FILE_HASH_PATTERN,
	type DataFileSystem,
} from "./data-file";
import {
	DATA_FILE_ACCEPT,
	DATA_FILE_HASH_PATTERN as PICKER_HASH_PATTERN,
	sha256Hex,
} from "@/services/data-files";

const system = (overrides: Partial<DataFileSystem> = {}): DataFileSystem => ({
	stat: vi.fn(async () => ({ size: 10, isFile: () => true })),
	readFile: vi.fn(async () => Buffer.from("id,email\n1,a@b.c\n")),
	fetchConfig: vi.fn(async () => ({
		entries: [{ key: "maxScenarioDataBytes", value: "1024" }],
	})),
	...overrides,
});

describe("readDataFile - the extension allowlist", () => {
	it("opens the extensions the picker offers", async () => {
		for (const extension of DATA_FILE_EXTENSIONS) {
			const result = await readDataFile(`/home/u/rows${extension}`, system());
			expect(result.fileName).toBe(`rows${extension}`);
		}
	});

	it("is case-insensitive, because Windows exports are USERS.CSV", async () => {
		await expect(readDataFile("/home/u/USERS.CSV", system())).resolves.toBeTruthy();
	});

	it("refuses anything else without touching the disk", async () => {
		const io = system();
		for (const path of ["/home/u/.ssh/id_rsa", "/etc/passwd", "/home/u/vayu.db", "/home/u/x"]) {
			await expect(readDataFile(path, io)).rejects.toThrow(/only opens data files/);
		}
		expect(io.readFile).not.toHaveBeenCalled();
		expect(io.stat).not.toHaveBeenCalled();
	});

	it("refuses an empty path rather than asking the filesystem about it", async () => {
		const io = system();
		await expect(readDataFile("", io)).rejects.toThrow(/No data file path/);
		expect(io.stat).not.toHaveBeenCalled();
	});
});

describe("readDataFile - the engine's byte cap", () => {
	it("follows the fetched setting rather than a hard-coded copy", async () => {
		// The #594 item-1 rule: a user who raises the setting must be able to
		// pre-fill the bigger file in the same session. Change only the config
		// value and the threshold has to move with it.
		const big = system({ stat: vi.fn(async () => ({ size: 5000, isFile: () => true })) });
		await expect(readDataFile("/home/u/rows.csv", big)).rejects.toThrow(/maxScenarioDataBytes/);

		const raised = system({
			stat: vi.fn(async () => ({ size: 5000, isFile: () => true })),
			fetchConfig: vi.fn(async () => ({
				entries: [{ key: "maxScenarioDataBytes", value: "1048576" }],
			})),
		});
		await expect(readDataFile("/home/u/rows.csv", raised)).resolves.toBeTruthy();
	});

	it("names the size and the setting, so 'raise it' is actionable", async () => {
		const io = system({ stat: vi.fn(async () => ({ size: 5000, isFile: () => true })) });
		await expect(readDataFile("/home/u/rows.csv", io)).rejects.toThrow(
			/5000 bytes, over the 1024/
		);
		expect(io.readFile).not.toHaveBeenCalled();
	});

	it("falls back to the seed when the engine cannot answer", async () => {
		// An unreachable engine is a state the user is about to hit anyway; it
		// must not be reported as a problem with their file.
		const io = system({
			fetchConfig: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		});
		await expect(readDataFile("/home/u/rows.csv", io)).resolves.toBeTruthy();
	});
});

describe("readDataFile - what it returns", () => {
	it("hands back bytes, leaving decoding to the module the picker uses", async () => {
		// Bytes, not text: `decode.ts` sniffs UTF-16 BOMs and refuses
		// replacement characters, and a file re-read here must not disagree with
		// the same file read through the picker.
		const io = system({ readFile: vi.fn(async () => Buffer.from([0xff, 0xfe, 0x69, 0x00])) });
		const { bytes } = await readDataFile("/home/u/rows.csv", io);
		expect(Array.from(bytes)).toEqual([0xff, 0xfe, 0x69, 0x00]);
	});

	it("carries the SHA-256 of those bytes, as 64 lowercase hex (#2051)", async () => {
		// The FIPS 180-2 "abc" vector, so the digest is checked against a value
		// this codebase did not compute.
		const io = system({ readFile: vi.fn(async () => Buffer.from("abc")) });
		const { hash } = await readDataFile("/home/u/abc.csv", io);
		expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("answers the same hash for the same bytes, and a different one when they change", async () => {
		const first = await readDataFile("/home/u/rows.csv", system());
		const second = await readDataFile("/home/u/rows.csv", system());
		expect(first.hash).toBe(second.hash);
		const edited = await readDataFile(
			"/home/u/rows.csv",
			system({ readFile: vi.fn(async () => Buffer.from("id,email\n1,a@b.d\n")) })
		);
		expect(edited.hash).not.toBe(first.hash);
	});

	it("reports a moved file as a moved file", async () => {
		const io = system({
			stat: vi.fn(async () => {
				throw new Error("ENOENT");
			}),
		});
		await expect(readDataFile("/home/u/gone.csv", io)).rejects.toThrow(/no longer at/);
	});

	it("refuses a directory that happens to end in .csv", async () => {
		const io = system({ stat: vi.fn(async () => ({ size: 4096, isFile: () => false })) });
		await expect(readDataFile("/home/u/exports.csv", io)).rejects.toThrow(/no longer at/);
	});
});

describe("the allowlist and the picker agree", () => {
	it("opens exactly the extensions the picker lets a user choose", () => {
		// An allowlist narrower than the picker is worse than none: the app would
		// remember a file it then refuses to re-open, every time, with no way for
		// the user to tell why. Duplicated across the process boundary out of
		// necessity - this is what keeps the two copies honest.
		expect([...DATA_FILE_EXTENSIONS].sort()).toEqual(DATA_FILE_ACCEPT.split(",").sort());
	});
});

describe("the hash and the picker's agree (#2051)", () => {
	it("answers the digest the picker computes for the same bytes", async () => {
		// A hand-picked file is hashed in the renderer and never comes through
		// here, so a run is only comparable to another if both answer one digest.
		// A UTF-16 BOM and a non-ASCII cell, so a digest taken over decoded text
		// rather than the raw bytes on either side would disagree.
		const bytes = Uint8Array.from([0xff, 0xfe, 0x69, 0x00, 0x64, 0x00, 0xe9, 0x00]);
		const { hash } = await readDataFile(
			"/home/u/rows.csv",
			system({ readFile: vi.fn(async () => Buffer.from(bytes)) })
		);
		expect(hash).toBe(await sha256Hex(bytes.buffer));
	});

	it("checks a stored hash against the same shape", () => {
		expect(DATA_FILE_HASH_PATTERN.source).toBe(PICKER_HASH_PATTERN.source);
	});
});
