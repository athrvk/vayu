/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The file channels a request-body file and the allowed-folder list need:
 *
 * - `file:allowFolder` opens the system folder picker and, when the user
 *   chooses a folder, allows it: `POST /file-roots` with the grant secret
 *   (#2356). Settings > Files, the body editor's "Allow folder..." and the
 *   import preview use it. The renderer cannot name the folder - only the
 *   dialog's starting point - because an allowed folder widens what every
 *   request may read from disk, and the engine refuses that write from anyone
 *   without the secret this process holds. The engine's answer comes back
 *   whole, so the renderer can tell "already allowed" (409) from a refusal.
 * - `file:removeAllowedFolder` stops allowing one, by the id of its row.
 * - `file:stat` answers a file's size and modification time for the body
 *   editor's "name, size" line. It never opens the file: the engine reads the
 *   bytes at send time, and a renderer that could read them would hold a
 *   general file-read channel this feature does not need.
 *
 * `file:stat` is a channel on which the renderer names a path, like
 * `dataFile:read` (data-file.ts), and it holds the same line (#2357): it
 * answers only for a file the user picked, dropped or opened (`file-grants.ts`)
 * or one under an allowed folder (`file-roots.ts`), the two things the engine
 * would send. Anything else answers null, so a path typed into the field that
 * was never picked and sits outside every allowed folder reads "not found",
 * and the channel cannot be used to probe the disk for what exists or how big
 * it is. A relative path, a non-string and anything that is not a regular file
 * answer null as well, so the line says "not found" rather than describing a
 * directory or a device.
 *
 * The two folder channels answer only the app window's main frame
 * (`ipc-sender.ts`). Kept out of main.ts so it can be tested; the Electron
 * surfaces arrive as arguments, the `log-ipc.ts` shape.
 */

import { promises as fs } from "fs";
import path from "path";
import { assertGranted, type IsGranted } from "./file-grants.js";
import type { FileRoots } from "./file-roots.js";
import type { EngineWrite, FileTrustRow } from "./file-trust-client.js";
import type { IpcSenderLike } from "./ipc-sender.js";
import { isWithin } from "./path-within.js";

/** What `file:stat` answers for a regular file. */
export interface FileStat {
	size: number;
	mtimeMs: number;
}

interface IpcLike {
	handle(
		channel: string,
		listener: (event: IpcSenderLike, ...args: unknown[]) => unknown
	): unknown;
}

/**
 * What `file:allowFolder` answers: the user cancelled, or the engine's answer
 * to allowing the folder they chose, with that folder as `path`.
 */
export type AllowFolderReply =
	{ outcome: "cancelled" } | (EngineWrite<FileTrustRow> & { path: string });

/** What `file:removeAllowedFolder` answers: the engine's answer to the delete. */
export type RemoveFolderReply = EngineWrite<null>;

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
	/** `FileTrustClient.createFileRoot`: `POST /file-roots` with the grant secret. */
	createFileRoot: (folder: string) => Promise<EngineWrite<FileTrustRow>>;
	/** `FileTrustClient.deleteFileRoot`, which refuses an id that is not a row id. */
	deleteFileRoot: (id: string) => Promise<EngineWrite<null>>;
	/** `isFromAppMainFrame` against the live main window. */
	isAppFrame: (event: IpcSenderLike) => boolean;
	stat?: (filePath: string) => Promise<{ size: number; mtimeMs: number; isFile: () => boolean }>;
	/** The host's absolute-path rule; injectable so both platforms' answers are testable. */
	isAbsolute?: (filePath: string) => boolean;
	/** `fs.promises.realpath` by default: the engine stores a root with symlinks resolved. */
	realpath?: (filePath: string) => Promise<string>;
	/**
	 * Whether the user picked, dropped or opened this path (`FileGrants.isGranted`).
	 * Required, so `file:stat` wired without the registry fails type-check.
	 */
	isGranted: IsGranted;
	/** The allowed folders (`createFileRoots`); `file:allowFolder` and the delete refresh it. */
	roots: FileRoots;
}

/** Whether @p filePath, with symlinks resolved, lies under an allowed folder. */
async function isUnderAllowedFolder(
	filePath: string,
	deps: Pick<FileIpcDeps, "realpath" | "roots">
): Promise<boolean> {
	const canonical = await (deps.realpath ?? fs.realpath)(filePath);
	const roots = await deps.roots.list();
	return roots.some((root) => isWithin(root, canonical));
}

/** `file:stat`'s whole decision, exported for the test. */
export async function statFile(
	filePath: unknown,
	deps: Pick<FileIpcDeps, "stat" | "isAbsolute" | "realpath" | "isGranted" | "roots">
): Promise<FileStat | null> {
	const isAbsolute = deps.isAbsolute ?? path.isAbsolute;
	const stat = deps.stat ?? fs.stat;
	if (typeof filePath !== "string" || !filePath || filePath.includes("\0")) return null;
	if (!isAbsolute(filePath)) return null;
	try {
		// A registry or roots read that fails is a "no": a gate that opens when it
		// cannot answer is no gate.
		const granted = await assertGranted(deps.isGranted, filePath).then(
			() => true,
			() => false
		);
		if (!granted && !(await isUnderAllowedFolder(filePath, deps))) return null;
		const info = await stat(filePath);
		if (!info.isFile()) return null;
		return { size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return null;
	}
}

/** The folder the user chose in the system picker, or null when they cancelled. */
export async function chooseFolder(
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

/** `file:allowFolder`'s whole decision, exported for the test. */
export async function allowFolder(
	options: unknown,
	deps: Pick<FileIpcDeps, "showOpenDialog" | "createFileRoot">
): Promise<AllowFolderReply> {
	const folder = await chooseFolder(options, deps);
	if (folder === null) return { outcome: "cancelled" };
	return { ...(await deps.createFileRoot(folder)), path: folder };
}

/** Throws for a sender that is not the app window, so the renderer's call rejects. */
function assertAppFrame(event: IpcSenderLike, deps: Pick<FileIpcDeps, "isAppFrame">): void {
	if (!deps.isAppFrame(event)) {
		throw new Error("Refused: allowed folders change only from the Vayu window.");
	}
}

export function registerFileIpc(ipc: IpcLike, deps: FileIpcDeps): void {
	ipc.handle("file:allowFolder", (event, options: unknown) => {
		assertAppFrame(event, deps);
		return allowFolder(options, deps).finally(() => deps.roots.invalidate());
	});
	ipc.handle("file:removeAllowedFolder", (event, id: unknown): Promise<RemoveFolderReply> => {
		assertAppFrame(event, deps);
		return deps
			.deleteFileRoot(typeof id === "string" ? id : "")
			.finally(() => deps.roots.invalidate());
	});
	ipc.handle("file:stat", (_event, filePath: unknown) => statFile(filePath, deps));
}
