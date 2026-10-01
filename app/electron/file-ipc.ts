/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The two file channels a request-body file and the allowed-folder list need:
 *
 * - `file:selectDirectory` opens the system folder picker and answers the
 *   chosen folder's path, or null when the user cancelled. Settings > Files
 *   and the body editor's "Allow folder..." use it; the engine is what stores
 *   the folder (`POST /file-roots`), and it re-checks that the path is a
 *   directory, so nothing here is a gate.
 * - `file:stat` answers a file's size and modification time for the body
 *   editor's "name, size" line. It never opens the file: the engine reads the
 *   bytes at send time, and a renderer that could read them would hold a
 *   general file-read channel this feature does not need.
 *
 * `file:stat` is a channel on which the renderer names a path, like
 * `dataFile:read` (data-file.ts). What it can learn is whether a regular file
 * exists at an absolute path and how big it is - the size the editor shows -
 * and nothing about its contents. A relative path, a non-string and anything
 * that is not a regular file answer null, so the line says "not found" rather
 * than describing a directory or a device.
 *
 * Kept out of main.ts so it can be tested; the Electron surfaces arrive as
 * arguments, the `log-ipc.ts` shape.
 */

import { promises as fs } from "fs";
import path from "path";

/** What `file:stat` answers for a regular file. */
export interface FileStat {
	size: number;
	mtimeMs: number;
}

interface IpcLike {
	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
}

/** The subset of `dialog.showOpenDialog`'s options this channel sets. */
export interface DirectoryDialogOptions {
	title: string;
	defaultPath?: string;
	properties: Array<"openDirectory" | "createDirectory">;
}

export interface FileIpcDeps {
	/** `dialog.showOpenDialog`, bound to the main window when there is one. */
	showOpenDialog: (
		options: DirectoryDialogOptions
	) => Promise<{ canceled: boolean; filePaths: string[] }>;
	stat?: (filePath: string) => Promise<{ size: number; mtimeMs: number; isFile: () => boolean }>;
	/** The host's absolute-path rule; injectable so both platforms' answers are testable. */
	isAbsolute?: (filePath: string) => boolean;
}

/** `file:stat`'s whole decision, exported for the test. */
export async function statFile(
	filePath: unknown,
	deps: Pick<FileIpcDeps, "stat" | "isAbsolute"> = {}
): Promise<FileStat | null> {
	const isAbsolute = deps.isAbsolute ?? path.isAbsolute;
	const stat = deps.stat ?? fs.stat;
	if (typeof filePath !== "string" || !filePath || filePath.includes("\0")) return null;
	if (!isAbsolute(filePath)) return null;
	try {
		const info = await stat(filePath);
		if (!info.isFile()) return null;
		return { size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return null;
	}
}

/** `file:selectDirectory`'s whole decision, exported for the test. */
export async function selectDirectory(
	options: unknown,
	deps: Pick<FileIpcDeps, "showOpenDialog">
): Promise<string | null> {
	const raw = options && typeof options === "object" ? (options as Record<string, unknown>) : {};
	const dialogOptions: DirectoryDialogOptions = {
		title: typeof raw.title === "string" && raw.title ? raw.title : "Choose a folder",
		properties: ["openDirectory", "createDirectory"],
	};
	if (typeof raw.defaultPath === "string" && raw.defaultPath) {
		dialogOptions.defaultPath = raw.defaultPath;
	}
	const result = await deps.showOpenDialog(dialogOptions);
	if (result.canceled) return null;
	return result.filePaths[0] ?? null;
}

export function registerFileIpc(ipc: IpcLike, deps: FileIpcDeps): void {
	ipc.handle("file:selectDirectory", (_event, options: unknown) =>
		selectDirectory(options, deps)
	);
	ipc.handle("file:stat", (_event, filePath: unknown) => statFile(filePath, deps));
}
