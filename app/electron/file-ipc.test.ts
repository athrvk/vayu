/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The main-process half of the two body-file channels: the folder picker
 * Settings > Files uses, and the stat behind the body editor's size line.
 * `file:stat` is a channel on which the renderer names a path, so what it
 * refuses to answer is the part worth pinning.
 */

import { describe, it, expect, vi } from "vitest";
import { registerFileIpc, selectDirectory, statFile } from "./file-ipc";

const posixAbsolute = (p: string) => p.startsWith("/");
const windowsAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p);

function fileStat(size: number, isFile = true) {
	return vi.fn(async () => ({ size, mtimeMs: 1_700_000_000_000, isFile: () => isFile }));
}

describe("statFile", () => {
	it("answers size and mtime for a regular file at an absolute path", async () => {
		const stat = fileStat(1234);
		await expect(statFile("/data/a.bin", { stat, isAbsolute: posixAbsolute })).resolves.toEqual(
			{
				size: 1234,
				mtimeMs: 1_700_000_000_000,
			}
		);
		expect(stat).toHaveBeenCalledWith("/data/a.bin");
	});

	it("follows the host's absolute-path rule, whichever host it is", async () => {
		const stat = fileStat(1);
		await expect(
			statFile("C:\\data\\a.bin", { stat, isAbsolute: windowsAbsolute })
		).resolves.not.toBeNull();
		await expect(
			statFile("C:\\data\\a.bin", { stat, isAbsolute: posixAbsolute })
		).resolves.toBeNull();
	});

	it("refuses a relative path without touching the disk", async () => {
		const stat = fileStat(1);
		await expect(statFile("a.bin", { stat, isAbsolute: posixAbsolute })).resolves.toBeNull();
		await expect(
			statFile("{{fixturesDir}}/a.bin", { stat, isAbsolute: posixAbsolute })
		).resolves.toBeNull();
		expect(stat).not.toHaveBeenCalled();
	});

	it("refuses a non-string or a NUL-carrying path", async () => {
		const stat = fileStat(1);
		await expect(statFile(42, { stat, isAbsolute: posixAbsolute })).resolves.toBeNull();
		await expect(statFile("/a\0b", { stat, isAbsolute: posixAbsolute })).resolves.toBeNull();
		expect(stat).not.toHaveBeenCalled();
	});

	it("answers null for something that is not a regular file", async () => {
		await expect(
			statFile("/data", { stat: fileStat(4096, false), isAbsolute: posixAbsolute })
		).resolves.toBeNull();
	});

	it("answers null for a path that does not exist", async () => {
		const stat = vi.fn(async () => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});
		await expect(
			statFile("/gone.bin", { stat, isAbsolute: posixAbsolute })
		).resolves.toBeNull();
	});
});

describe("selectDirectory", () => {
	it("asks for a directory and answers the chosen path", async () => {
		const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ["/fixtures"] }));
		await expect(
			selectDirectory(
				{ defaultPath: "/home/me", title: "Allow a folder" },
				{ showOpenDialog }
			)
		).resolves.toBe("/fixtures");
		expect(showOpenDialog).toHaveBeenCalledWith({
			title: "Allow a folder",
			defaultPath: "/home/me",
			properties: ["openDirectory", "createDirectory"],
		});
	});

	it("answers null when the user cancels", async () => {
		const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
		await expect(selectDirectory(undefined, { showOpenDialog })).resolves.toBeNull();
	});

	it("ignores option members of the wrong type", async () => {
		const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ["/x"] }));
		await selectDirectory({ defaultPath: 7, title: null }, { showOpenDialog });
		expect(showOpenDialog).toHaveBeenCalledWith({
			title: "Choose a folder",
			properties: ["openDirectory", "createDirectory"],
		});
	});
});

describe("registerFileIpc", () => {
	it("registers both channels against their handlers", async () => {
		const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
		const ipc = {
			handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
				handlers.set(channel, fn);
			},
		};
		const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ["/picked"] }));
		registerFileIpc(ipc, { showOpenDialog, stat: fileStat(9), isAbsolute: posixAbsolute });

		expect([...handlers.keys()].sort()).toEqual(["file:selectDirectory", "file:stat"]);
		await expect(handlers.get("file:selectDirectory")?.({}, {})).resolves.toBe("/picked");
		await expect(handlers.get("file:stat")?.({}, "/a.bin")).resolves.toEqual({
			size: 9,
			mtimeMs: 1_700_000_000_000,
		});
	});
});
