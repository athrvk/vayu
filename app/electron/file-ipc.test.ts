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
 * path, so what it refuses to answer is the part worth pinning (#2357: a path
 * that is neither picked nor under an allowed folder); the two folder channels
 * change what every request may read, so who may call them is.
 */

import { describe, it, expect, vi, type Mock } from "vitest";
import { allowFolder, chooseFolder, registerFileIpc, statFile } from "./file-ipc";
import type { FileRoots } from "./file-roots";
import type { EngineWrite, FileTrustRow } from "./file-trust-client";
import type { IpcSenderLike } from "./ipc-sender";

const posixAbsolute = (p: string) => p.startsWith("/");
const windowsAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p);

function fileStat(size: number, isFile = true) {
	return vi.fn(async () => ({ size, mtimeMs: 1_700_000_000_000, isFile: () => isFile }));
}

/** A roots reader holding @p folders, with `invalidate` spied. */
function rootsOf(...folders: string[]): FileRoots & { invalidate: Mock<() => void> } {
	return { list: vi.fn(async () => folders), invalidate: vi.fn() };
}

/** The gate deps for a path the user picked: granted, no folder allowed. */
const allowed = { isGranted: async () => true, roots: rootsOf() };

const identity = async (p: string) => p;

describe("statFile", () => {
	it("answers size and mtime for a regular file at an absolute path", async () => {
		const stat = fileStat(1234);
		await expect(
			statFile("/data/a.bin", { stat, isAbsolute: posixAbsolute, ...allowed })
		).resolves.toEqual({
			size: 1234,
			mtimeMs: 1_700_000_000_000,
		});
		expect(stat).toHaveBeenCalledWith("/data/a.bin");
	});

	it("follows the host's absolute-path rule, whichever host it is", async () => {
		const stat = fileStat(1);
		await expect(
			statFile("C:\\data\\a.bin", { stat, isAbsolute: windowsAbsolute, ...allowed })
		).resolves.not.toBeNull();
		await expect(
			statFile("C:\\data\\a.bin", { stat, isAbsolute: posixAbsolute, ...allowed })
		).resolves.toBeNull();
	});

	it("refuses a relative path without touching the disk", async () => {
		const stat = fileStat(1);
		await expect(
			statFile("a.bin", { stat, isAbsolute: posixAbsolute, ...allowed })
		).resolves.toBeNull();
		await expect(
			statFile("{{fixturesDir}}/a.bin", { stat, isAbsolute: posixAbsolute, ...allowed })
		).resolves.toBeNull();
		expect(stat).not.toHaveBeenCalled();
	});

	it("refuses a non-string or a NUL-carrying path", async () => {
		const stat = fileStat(1);
		await expect(
			statFile(42, { stat, isAbsolute: posixAbsolute, ...allowed })
		).resolves.toBeNull();
		await expect(
			statFile("/a\0b", { stat, isAbsolute: posixAbsolute, ...allowed })
		).resolves.toBeNull();
		expect(stat).not.toHaveBeenCalled();
	});

	it("answers null for something that is not a regular file", async () => {
		await expect(
			statFile("/data", {
				stat: fileStat(4096, false),
				isAbsolute: posixAbsolute,
				...allowed,
			})
		).resolves.toBeNull();
	});

	it("answers null for a path that does not exist", async () => {
		const stat = vi.fn(async () => {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});
		await expect(
			statFile("/gone.bin", { stat, isAbsolute: posixAbsolute, ...allowed })
		).resolves.toBeNull();
	});

	describe("the grant gate", () => {
		const stat = () => fileStat(77);

		it("answers null for an existing file that is neither picked nor under an allowed folder", async () => {
			const s = stat();
			await expect(
				statFile("/etc/passwd", {
					stat: s,
					isAbsolute: posixAbsolute,
					realpath: identity,
					isGranted: async () => false,
					roots: rootsOf("/fixtures"),
				})
			).resolves.toBeNull();
			expect(s).not.toHaveBeenCalled();
		});

		it("answers a picked file wherever it is, without consulting the folders", async () => {
			const roots = rootsOf();
			const isGranted = vi.fn(async () => true);
			await expect(
				statFile("/home/me/a.bin", {
					stat: stat(),
					isAbsolute: posixAbsolute,
					isGranted,
					roots,
				})
			).resolves.toEqual({ size: 77, mtimeMs: 1_700_000_000_000 });
			expect(isGranted).toHaveBeenCalledWith("/home/me/a.bin");
			expect(roots.list).not.toHaveBeenCalled();
		});

		it("answers a file under an allowed folder that was never picked", async () => {
			await expect(
				statFile("/fixtures/sub/a.bin", {
					stat: stat(),
					isAbsolute: posixAbsolute,
					realpath: identity,
					isGranted: async () => false,
					roots: rootsOf("/other", "/fixtures"),
				})
			).resolves.toEqual({ size: 77, mtimeMs: 1_700_000_000_000 });
		});

		it("compares by path component, so root /a/b does not admit /a/bc", async () => {
			const deps = {
				stat: stat(),
				isAbsolute: posixAbsolute,
				realpath: identity,
				isGranted: async () => false,
				roots: rootsOf("/a/b"),
			};
			await expect(statFile("/a/bc/x.bin", deps)).resolves.toBeNull();
			await expect(statFile("/a/b/x.bin", deps)).resolves.not.toBeNull();
		});

		it("refuses a symlink inside an allowed folder that points outside it", async () => {
			const s = stat();
			await expect(
				statFile("/fixtures/link.bin", {
					stat: s,
					isAbsolute: posixAbsolute,
					realpath: async () => "/etc/shadow",
					isGranted: async () => false,
					roots: rootsOf("/fixtures"),
				})
			).resolves.toBeNull();
			expect(s).not.toHaveBeenCalled();
		});

		it("answers null for a path that cannot be resolved, as for one that is missing", async () => {
			await expect(
				statFile("/fixtures/gone.bin", {
					stat: stat(),
					isAbsolute: posixAbsolute,
					realpath: async () => {
						throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
					},
					isGranted: async () => false,
					roots: rootsOf("/fixtures"),
				})
			).resolves.toBeNull();
		});

		it("fails closed when the folders cannot be read, while a picked file still answers", async () => {
			const roots: FileRoots = {
				list: async () => {
					throw new Error("engine down");
				},
				invalidate: vi.fn(),
			};
			const base = { stat: stat(), isAbsolute: posixAbsolute, realpath: identity, roots };

			await expect(
				statFile("/fixtures/a.bin", { ...base, isGranted: async () => false })
			).resolves.toBeNull();
			await expect(
				statFile("/fixtures/a.bin", { ...base, isGranted: async () => true })
			).resolves.toEqual({ size: 77, mtimeMs: 1_700_000_000_000 });
		});

		it("fails closed when the grant registry itself fails, but a folder still admits", async () => {
			const isGranted = async (): Promise<boolean> => {
				throw new Error("registry down");
			};
			const base = { stat: stat(), isAbsolute: posixAbsolute, realpath: identity, isGranted };

			await expect(
				statFile("/elsewhere/a.bin", { ...base, roots: rootsOf("/fixtures") })
			).resolves.toBeNull();
			await expect(
				statFile("/fixtures/a.bin", { ...base, roots: rootsOf("/fixtures") })
			).resolves.not.toBeNull();
		});
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
		const roots = rootsOf();
		const isGranted = vi.fn(async () => true);
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
			isGranted,
			roots,
		});
		const call = (channel: string, ...args: unknown[]) =>
			handlers.get(channel)?.({ sender: {} }, ...args);
		return { handlers, call, showOpenDialog, createFileRoot, deleteFileRoot, roots, isGranted };
	}

	it("registers the three channels against their handlers", async () => {
		const { handlers, call, deleteFileRoot, isGranted } = register(true);

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
		expect(isGranted).toHaveBeenCalledWith("/a.bin");
	});

	it("answers file:stat null when the injected gate says neither granted nor rooted", async () => {
		const { call, isGranted } = register(true);
		isGranted.mockResolvedValue(false);

		await expect(call("file:stat", "/nowhere/a.bin")).resolves.toBeNull();
	});

	it("refreshes the allowed folders after the picker and after a delete, whatever the outcome", async () => {
		const { call, roots, createFileRoot, deleteFileRoot } = register(true);

		await call("file:allowFolder", {});
		expect(roots.invalidate).toHaveBeenCalledTimes(1);

		createFileRoot.mockResolvedValueOnce({
			outcome: "refused",
			status: 409,
			code: "conflict",
			message: "already",
		});
		await call("file:allowFolder", {});
		expect(roots.invalidate).toHaveBeenCalledTimes(2);

		await call("file:removeAllowedFolder", "froot_1");
		expect(roots.invalidate).toHaveBeenCalledTimes(3);
		expect(deleteFileRoot).toHaveBeenCalledOnce();
	});

	it("does not refresh the folders for a refused sender", () => {
		const { call, roots } = register(false);

		expect(() => call("file:allowFolder", {})).toThrow();
		expect(() => call("file:removeAllowedFolder", "froot_1")).toThrow();
		expect(roots.invalidate).not.toHaveBeenCalled();
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
