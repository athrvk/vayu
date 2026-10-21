/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The gates on the channel that lets the renderer name a file path (issue
 * #599).
 *
 * What keeps it from being "read any file" is the whole value of the module: an
 * extension allowlist, the grant on the path (#2357: only files the user
 * picked, dropped or opened) and the engine's *fetched* byte cap. All are driven
 * here against an injected filesystem, so a regression in any shows up as a test
 * rather than as a file the app should never have opened.
 */

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { FileNotGrantedError, NOT_GRANTED_MESSAGE } from "./file-grants";
import {
	createDataFileSystem,
	DataFileMissingError,
	hashDataFile,
	hashDataFileReply,
	readDataFile,
	DATA_FILE_EXTENSIONS,
	DATA_FILE_HASH_PATTERN,
	type DataFileSystem,
} from "./data-file";
import { DATA_FILE_ACCEPT, sha256Hex } from "@/services/data-files";
import { DATA_FILE_HASH_PATTERN as PICKER_HASH_PATTERN } from "@/services/data-files/hash";

const system = (overrides: Partial<DataFileSystem> = {}): DataFileSystem => ({
	stat: vi.fn(async () => ({ size: 10, isFile: () => true })),
	readFile: vi.fn(async () => Buffer.from("id,email\n1,a@b.c\n")),
	hashFile: vi.fn(async () => "f".repeat(64)),
	fetchConfig: vi.fn(async () => ({
		entries: [{ key: "maxScenarioDataBytes", value: "1024" }],
	})),
	isGranted: vi.fn(async () => true),
	...overrides,
});

/*
 * The grant (#2357): a path the user never picked, dropped or opened is refused
 * however well it passes the other gates.
 *
 * Mutation check: drop `assertGranted` from `statOpenableDataFile` (or make the
 * injected `isGranted` answer true) and every "never granted" case fails; move
 * the grant after the stat and the "same answer whether or not it exists" case
 * fails.
 */
describe("the grant on the path (#2357)", () => {
	const ungranted = () => system({ isGranted: vi.fn(async () => false) });

	it("refuses a read of a file that exists with an allowed extension but was never granted", async () => {
		const io = ungranted();
		await expect(readDataFile("/home/u/rows.csv", io)).rejects.toThrow(NOT_GRANTED_MESSAGE);
		await expect(readDataFile("/home/u/rows.csv", io)).rejects.toBeInstanceOf(
			FileNotGrantedError
		);
		expect(io.isGranted).toHaveBeenCalledWith("/home/u/rows.csv");
		expect(io.readFile).not.toHaveBeenCalled();
	});

	it("tells the user to pick the file again", () => {
		expect(NOT_GRANTED_MESSAGE).toMatch(/Pick the file again\.$/);
	});

	it("reads a granted file", async () => {
		const io = system({ isGranted: vi.fn(async (p: string) => p === "/home/u/rows.csv") });
		await expect(readDataFile("/home/u/rows.csv", io)).resolves.toMatchObject({
			fileName: "rows.csv",
		});
	});

	it("answers a hash request for an ungranted path as missing, never as a digest", async () => {
		const io = ungranted();
		await expect(hashDataFileReply("/home/u/rows.csv", io)).resolves.toEqual({
			status: "missing",
		});
		expect(io.hashFile).not.toHaveBeenCalled();
	});

	it("rejects hashDataFile itself for an ungranted path, so a caller outside IPC can tell", async () => {
		const io = ungranted();
		await expect(hashDataFile("/home/u/rows.csv", io)).rejects.toBeInstanceOf(
			FileNotGrantedError
		);
		expect(io.hashFile).not.toHaveBeenCalled();
	});

	it("hashes a granted file", async () => {
		await expect(hashDataFileReply("/home/u/rows.csv", system())).resolves.toEqual({
			status: "found",
			hash: "f".repeat(64),
		});
	});

	it("answers an ungranted path the same whether or not a file is there", async () => {
		const missing = system({
			isGranted: vi.fn(async () => false),
			stat: vi.fn(async () => {
				throw new Error("ENOENT");
			}),
		});
		await expect(readDataFile("/home/u/rows.csv", missing)).rejects.toBeInstanceOf(
			FileNotGrantedError
		);
		expect(missing.stat).not.toHaveBeenCalled();
		await expect(readDataFile("/home/u/rows.csv", ungranted())).rejects.toBeInstanceOf(
			FileNotGrantedError
		);
	});

	it("reports a granted path with no file as moved", async () => {
		const io = system({
			stat: vi.fn(async () => {
				throw new Error("ENOENT");
			}),
		});
		await expect(readDataFile("/home/u/rows.csv", io)).rejects.toBeInstanceOf(
			DataFileMissingError
		);
		await expect(hashDataFile("/home/u/rows.csv", io)).rejects.toBeInstanceOf(
			DataFileMissingError
		);
	});

	it("does not consult the registry for a refused extension or an empty path", async () => {
		const io = ungranted();
		await expect(readDataFile("/home/u/.ssh/id_rsa", io)).rejects.toThrow(
			/only opens data files/
		);
		await expect(readDataFile("", io)).rejects.toThrow(/No data file path/);
		expect(io.isGranted).not.toHaveBeenCalled();
	});

	it("fails closed when the registry itself rejects", async () => {
		const io = system({
			isGranted: vi.fn(async () => {
				throw new Error("engine unreachable");
			}),
		});
		await expect(readDataFile("/home/u/rows.csv", io)).rejects.toBeInstanceOf(
			FileNotGrantedError
		);
		await expect(hashDataFileReply("/home/u/rows.csv", io)).resolves.toEqual({
			status: "missing",
		});
		expect(io.readFile).not.toHaveBeenCalled();
		expect(io.hashFile).not.toHaveBeenCalled();
	});
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
		const offered = DATA_FILE_ACCEPT.split(",");
		expect(offered.length).toBeGreaterThan(0);
		expect([...DATA_FILE_EXTENSIONS].sort()).toEqual(offered.sort());
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

/*
 * `dataFile:hash` (#2051): the digest of the file as it is now, so a run's
 * `dataFileHash` can be compared with the file on disk without carrying its
 * bytes. Driven against a real file, because the streamed digest is the one
 * part the injected system would otherwise stand in for.
 *
 * Mutation check: hash anything but the file's whole contents (drop a chunk,
 * or digest the path) and the first case fails; drop the path gates and the
 * refusal case reads the disk. Throw a plain `Error` at either not-found site
 * and the `DataFileMissingError` cases fail; throw `DataFileMissingError` for
 * a refused extension or empty path and the refusal cases fail.
 */
describe("hashDataFile", () => {
	const onDisk = createDataFileSystem(async () => true);
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "vayu-data-file-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("answers the digest a read of the same file answers, from the disk", async () => {
		const file = path.join(dir, "abc.csv");
		await fs.writeFile(file, "abc");

		const hash = await hashDataFile(file, onDisk);

		// The FIPS 180-2 "abc" vector, a value this codebase did not compute.
		expect(hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		const read = await readDataFile(
			file,
			system({ stat: (p) => fs.stat(p), readFile: (p) => fs.readFile(p) })
		);
		expect(read.hash).toBe(hash);
	});

	it("answers a different digest once the file is edited", async () => {
		const file = path.join(dir, "rows.csv");
		await fs.writeFile(file, "id\n1\n");
		const before = await hashDataFile(file, onDisk);
		await fs.writeFile(file, "id\n2\n");
		expect(await hashDataFile(file, onDisk)).not.toBe(before);
	});

	it("reports a missing file the way a read does", async () => {
		await expect(hashDataFile(path.join(dir, "gone.csv"), onDisk)).rejects.toThrow(
			/The file is no longer at .*gone\.csv - pick it again\./
		);
	});

	it("throws DataFileMissingError when the stat finds nothing", async () => {
		const io = system({
			stat: vi.fn(async () => {
				throw new Error("ENOENT");
			}),
		});
		await expect(hashDataFile("/home/u/rows.csv", io)).rejects.toBeInstanceOf(
			DataFileMissingError
		);
		expect(io.hashFile).not.toHaveBeenCalled();
	});

	it("throws DataFileMissingError for a path that is not a regular file", async () => {
		const io = system({ stat: vi.fn(async () => ({ size: 0, isFile: () => false })) });
		await expect(hashDataFile("/home/u/rows.csv", io)).rejects.toBeInstanceOf(
			DataFileMissingError
		);
	});

	it("throws DataFileMissingError when the file vanishes between the stat and the hash", async () => {
		const io = system({
			hashFile: vi.fn(async () => {
				throw new Error("ENOENT");
			}),
		});
		await expect(hashDataFile("/home/u/rows.csv", io)).rejects.toBeInstanceOf(
			DataFileMissingError
		);
	});

	it("keeps the sentence a read shows for a file that has moved", async () => {
		const io = system({
			stat: vi.fn(async () => {
				throw new Error("ENOENT");
			}),
		});
		await expect(readDataFile("/home/u/rows.csv", io)).rejects.toThrow(
			"The file is no longer at /home/u/rows.csv - pick it again."
		);
		await expect(readDataFile("/home/u/rows.csv", io)).rejects.toBeInstanceOf(
			DataFileMissingError
		);
	});

	it("passes the read's path gates before touching the disk", async () => {
		const io = system();
		await expect(hashDataFile("/home/u/.ssh/id_rsa", io)).rejects.toThrow(
			/only opens data files/
		);
		await expect(hashDataFile("", io)).rejects.toThrow(/No data file path/);
		expect(io.stat).not.toHaveBeenCalled();
		expect(io.hashFile).not.toHaveBeenCalled();
	});

	it("does not call a refused request a missing file", async () => {
		const io = system();
		for (const refused of ["/home/u/.ssh/id_rsa", ""]) {
			const error = await hashDataFile(refused, io).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(DataFileMissingError);
		}
	});

	it("needs no engine: a hash fetches no byte cap", async () => {
		const io = system();
		await expect(hashDataFile("/home/u/rows.csv", io)).resolves.toBe("f".repeat(64));
		expect(io.fetchConfig).not.toHaveBeenCalled();
		expect(io.readFile).not.toHaveBeenCalled();
	});
});

/*
 * The `dataFile:hash` reply (#2057): a file that is gone is data the renderer can
 * branch on, because an error crossing IPC keeps only its message.
 *
 * Mutation check: map every error to `missing` and the refusal cases fail;
 * rethrow `DataFileMissingError` and the missing cases fail.
 */
describe("hashDataFileReply", () => {
	it("answers found with the digest", async () => {
		await expect(hashDataFileReply("/home/u/rows.csv", system())).resolves.toEqual({
			status: "found",
			hash: "f".repeat(64),
		});
	});

	it("answers missing when the stat finds nothing", async () => {
		const io = system({
			stat: vi.fn(async () => {
				throw new Error("ENOENT");
			}),
		});
		await expect(hashDataFileReply("/home/u/rows.csv", io)).resolves.toEqual({
			status: "missing",
		});
	});

	it("answers missing when the hash cannot read the file", async () => {
		const io = system({
			hashFile: vi.fn(async () => {
				throw new Error("EACCES");
			}),
		});
		await expect(hashDataFileReply("/home/u/rows.csv", io)).resolves.toEqual({
			status: "missing",
		});
	});

	it("still rejects a refused request, which says nothing about the file", async () => {
		await expect(hashDataFileReply("/home/u/.ssh/id_rsa", system())).rejects.toThrow(
			/only opens data files/
		);
		await expect(hashDataFileReply("", system())).rejects.toThrow(/No data file path/);
	});
});
