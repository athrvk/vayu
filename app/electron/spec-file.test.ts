/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The gates on the channel that reads the files an imported spec references
 * (issue #649).
 *
 * Same shape as `data-file.test.ts`, because the channel is the same widening of
 * the same posture: the renderer hands over a document path and a reference, and
 * what keeps that from being "read any file" is an extension allowlist plus the
 * engine's fetched cap. Both are driven against an injected filesystem, so a
 * regression in either shows up here rather than as a file the app should never
 * have opened.
 */

import { describe, it, expect, vi } from "vitest";
import path from "path";
import { readSpecFile, SPEC_FILE_EXTENSIONS, type SpecFileSystem } from "./spec-file";

const system = (overrides: Partial<SpecFileSystem> = {}): SpecFileSystem => ({
	stat: vi.fn(async () => ({ size: 10, isFile: () => true })),
	readFile: vi.fn(async () => Buffer.from('{"Pet":{"type":"object"}}')),
	fetchConfig: vi.fn(async () => ({
		entries: [{ key: "maxSpecDocumentBytes", value: "1024" }],
	})),
	...overrides,
});

const SPEC = "/home/u/api/spec/openapi.yaml";

describe("readSpecFile - resolving the reference", () => {
	it("resolves it against the picked document's directory, not the process cwd", async () => {
		// The renderer passes the ref as the *document* wrote it; the resolution
		// happens here, which is what keeps the web layer from naming directories.
		const io = system();
		await readSpecFile(SPEC, "./schemas/pet.json", io);
		expect(io.readFile).toHaveBeenCalledWith(path.resolve("/home/u/api/spec/schemas/pet.json"));
	});

	it("follows a reference that climbs out of that directory", async () => {
		// `spec/openapi.yaml` -> `../shared/error.yaml` is an ordinary layout, and
		// the file is named by a document the user chose to import.
		const io = system();
		const result = await readSpecFile(SPEC, "../shared/error.yaml", io);
		expect(io.readFile).toHaveBeenCalledWith(path.resolve("/home/u/api/shared/error.yaml"));
		expect(result.fileName).toBe("error.yaml");
	});

	it("refuses an absolute reference, which describes one machine's disk", async () => {
		const io = system();
		await expect(readSpecFile(SPEC, "/etc/hosts.json", io)).rejects.toThrow(/absolute path/);
		expect(io.stat).not.toHaveBeenCalled();
	});

	it("refuses an empty document path or an empty reference", async () => {
		const io = system();
		await expect(readSpecFile("", "./pet.json", io)).rejects.toThrow(/No spec file path/);
		await expect(readSpecFile(SPEC, "  ", io)).rejects.toThrow(/No referenced file/);
		expect(io.stat).not.toHaveBeenCalled();
	});
});

describe("readSpecFile - the extension allowlist", () => {
	it("opens the three a spec can be written in", async () => {
		for (const extension of SPEC_FILE_EXTENSIONS) {
			const result = await readSpecFile(SPEC, `./defs${extension}`, system());
			expect(result.fileName).toBe(`defs${extension}`);
		}
	});

	it("is case-insensitive, because Windows exports are SCHEMA.JSON", async () => {
		await expect(readSpecFile(SPEC, "./SCHEMA.JSON", system())).resolves.toBeTruthy();
	});

	it("refuses anything else without touching the disk", async () => {
		const io = system();
		for (const ref of ["../../.ssh/id_rsa", "./vayu.db", "./secrets.env", "./notes"]) {
			await expect(readSpecFile(SPEC, ref, io)).rejects.toThrow(/only opens spec files/);
		}
		expect(io.readFile).not.toHaveBeenCalled();
		expect(io.stat).not.toHaveBeenCalled();
	});
});

describe("readSpecFile - the engine's byte cap", () => {
	it("follows the fetched setting rather than a hard-coded copy", async () => {
		const big = system({ stat: vi.fn(async () => ({ size: 5000, isFile: () => true })) });
		await expect(readSpecFile(SPEC, "./pet.json", big)).rejects.toThrow(/maxSpecDocumentBytes/);

		const raised = system({
			stat: vi.fn(async () => ({ size: 5000, isFile: () => true })),
			fetchConfig: vi.fn(async () => ({
				entries: [{ key: "maxSpecDocumentBytes", value: "1048576" }],
			})),
		});
		await expect(readSpecFile(SPEC, "./pet.json", raised)).resolves.toBeTruthy();
	});

	it("names the size and the setting, so 'raise it' is actionable", async () => {
		const io = system({ stat: vi.fn(async () => ({ size: 5000, isFile: () => true })) });
		await expect(readSpecFile(SPEC, "./pet.json", io)).rejects.toThrow(
			/pet.json is 5000 bytes, over the 1024/
		);
		expect(io.readFile).not.toHaveBeenCalled();
	});

	it("falls back to the seed when the engine cannot answer", async () => {
		const io = system({
			fetchConfig: vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		});
		await expect(readSpecFile(SPEC, "./pet.json", io)).resolves.toBeTruthy();
	});
});

describe("readSpecFile - what it returns", () => {
	it("hands back bytes, as the data-file channel does", async () => {
		const io = system({ readFile: vi.fn(async () => Buffer.from([0x7b, 0x7d])) });
		const { bytes } = await readSpecFile(SPEC, "./pet.json", io);
		expect(Array.from(bytes)).toEqual([0x7b, 0x7d]);
	});

	it("reports a reference that is not there by naming both halves", async () => {
		const io = system({
			stat: vi.fn(async () => {
				throw new Error("ENOENT");
			}),
		});
		await expect(readSpecFile(SPEC, "./gone.json", io)).rejects.toThrow(
			/references \.\/gone\.json, which is not at .*gone\.json/
		);
	});

	it("refuses a directory that happens to end in .json", async () => {
		const io = system({ stat: vi.fn(async () => ({ size: 4096, isFile: () => false })) });
		await expect(readSpecFile(SPEC, "./schemas.json", io)).rejects.toThrow(/is not at/);
	});
});
