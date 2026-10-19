/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The main-process half of the body-file channels: the folder picker that
 * allows what was chosen, the delete beside it, and the stat behind the body
 * editor's size line. `file:stat` is a channel on which the renderer names a
 * path, so what it refuses to answer is the part worth pinning; the two folder
 * channels change what every request may read, so who may call them is.
 */

import { describe, it, expect, vi } from "vitest";
import { allowFolder, chooseFolder, registerFileIpc, statFile } from "./file-ipc";
import type { EngineWrite, FileTrustRow } from "./file-trust-client";
import type { IpcSenderLike } from "./ipc-sender";

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

describe("chooseFolder", () => {
	it("asks for a directory and answers the chosen path", async () => {
		const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ["/fixtures"] }));
		await expect(
			chooseFolder({ defaultPath: "/home/me", title: "Allow a folder" }, { showOpenDialog })
		).resolves.toBe("/fixtures");
		expect(showOpenDialog).toHaveBeenCalledWith({
			title: "Allow a folder",
			defaultPath: "/home/me",
			properties: ["openDirectory", "createDirectory"],
		});
	});

	it("answers null when the user cancels", async () => {
		const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
		await expect(chooseFolder(undefined, { showOpenDialog })).resolves.toBeNull();
	});

	it("ignores option members of the wrong type", async () => {
		const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ["/x"] }));
		await chooseFolder({ defaultPath: 7, title: null }, { showOpenDialog });
		expect(showOpenDialog).toHaveBeenCalledWith({
			title: "Choose a folder",
			properties: ["openDirectory", "createDirectory"],
		});
	});
});

const ROOT: FileTrustRow = { id: "froot_1", path: "/fixtures", createdAt: 1 };

describe("allowFolder", () => {
	it("allows the folder the user chose and answers the engine's row with it", async () => {
		const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ["/fixtures/"] }));
		const createFileRoot = vi.fn(async (): Promise<EngineWrite<FileTrustRow>> => ({
			outcome: "done",
			value: ROOT,
		}));

		await expect(allowFolder({}, { showOpenDialog, createFileRoot })).resolves.toEqual({
			outcome: "done",
			value: ROOT,
			path: "/fixtures/",
		});
		expect(createFileRoot).toHaveBeenCalledWith("/fixtures/");
	});

	it("keeps the engine's 409, so the renderer can say the folder already was allowed", async () => {
		const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ["/fixtures"] }));
		const createFileRoot = vi.fn(async (): Promise<EngineWrite<FileTrustRow>> => ({
			outcome: "refused",
			status: 409,
			code: "conflict",
			message: "The folder '/fixtures' is already allowed (id froot_1)",
		}));

		await expect(allowFolder({}, { showOpenDialog, createFileRoot })).resolves.toMatchObject({
			outcome: "refused",
			status: 409,
			path: "/fixtures",
		});
	});

	it("allows nothing when the user cancels", async () => {
		const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
		const createFileRoot = vi.fn();

		await expect(allowFolder({}, { showOpenDialog, createFileRoot })).resolves.toEqual({
			outcome: "cancelled",
		});
		expect(createFileRoot).not.toHaveBeenCalled();
	});

	it("takes the folder from the picker, never from the options", async () => {
		const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ["/picked"] }));
		const createFileRoot = vi.fn(async (): Promise<EngineWrite<FileTrustRow>> => ({
			outcome: "done",
			value: ROOT,
		}));

		await allowFolder(
			{ defaultPath: "/etc", path: "/etc" },
			{ showOpenDialog, createFileRoot }
		);

		expect(createFileRoot.mock.calls).toEqual([["/picked"]]);
	});
});

describe("registerFileIpc", () => {
	function register(isAppFrame: boolean) {
		const handlers = new Map<string, (event: IpcSenderLike, ...args: unknown[]) => unknown>();
		const ipc = {
			handle: (
				channel: string,
				fn: (event: IpcSenderLike, ...args: unknown[]) => unknown
			) => {
				handlers.set(channel, fn);
			},
		};
		const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ["/picked"] }));
		const createFileRoot = vi.fn(async (): Promise<EngineWrite<FileTrustRow>> => ({
			outcome: "done",
			value: ROOT,
		}));
		const deleteFileRoot = vi.fn(async (): Promise<EngineWrite<null>> => ({
			outcome: "done",
			value: null,
		}));
		registerFileIpc(ipc, {
			showOpenDialog,
			createFileRoot,
			deleteFileRoot,
			isAppFrame: () => isAppFrame,
			stat: fileStat(9),
			isAbsolute: posixAbsolute,
		});
		const call = (channel: string, ...args: unknown[]) =>
			handlers.get(channel)?.({ sender: {} }, ...args);
		return { handlers, call, showOpenDialog, createFileRoot, deleteFileRoot };
	}

	it("registers the three channels against their handlers", async () => {
		const { handlers, call, deleteFileRoot } = register(true);

		expect([...handlers.keys()].sort()).toEqual([
			"file:allowFolder",
			"file:removeAllowedFolder",
			"file:stat",
		]);
		await expect(call("file:allowFolder", {})).resolves.toMatchObject({
			outcome: "done",
			path: "/picked",
		});
		await expect(call("file:removeAllowedFolder", "froot_1")).resolves.toEqual({
			outcome: "done",
			value: null,
		});
		expect(deleteFileRoot).toHaveBeenCalledWith("froot_1");
		await expect(call("file:stat", "/a.bin")).resolves.toEqual({
			size: 9,
			mtimeMs: 1_700_000_000_000,
		});
	});

	it("hands a non-string id on as one the client refuses", async () => {
		const { call, deleteFileRoot } = register(true);

		await call("file:removeAllowedFolder", { id: "froot_1" });

		expect(deleteFileRoot).toHaveBeenCalledWith("");
	});

	it("refuses both folder channels outside the app window, before any dialog or write", () => {
		const { call, showOpenDialog, createFileRoot, deleteFileRoot } = register(false);

		expect(() => call("file:allowFolder", {})).toThrow(/Vayu window/);
		expect(() => call("file:removeAllowedFolder", "froot_1")).toThrow(/Vayu window/);
		expect(showOpenDialog).not.toHaveBeenCalled();
		expect(createFileRoot).not.toHaveBeenCalled();
		expect(deleteFileRoot).not.toHaveBeenCalled();
	});
});
