/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `file:save`: what the renderer exports (a run report, an OpenAPI or Postman
 * document, an environment, a response or capture body) written to the path
 * the user picks in the system save dialog, answering whether it was written
 * (#3246). An `<a download>` cannot answer that: the click returns before the
 * dialog Electron opens for it does, so a caller could only say "Exported"
 * on a save the user then cancelled.
 *
 * The renderer chooses the bytes and suggests a name, and nothing else. The
 * name is cut to its last path segment and the dialog opens in the user's
 * Downloads folder, so a renderer cannot steer the dialog to a directory; the
 * path written is the one the user confirmed. No grant is recorded for it
 * (`file-grants.ts`): a file the app wrote is not one the user picked to send.
 *
 * Answers only the app window's main frame (`ipc-sender.ts`). A refusal, an
 * argument of the wrong shape and an oversized payload reject before the
 * dialog opens; a write that fails after the user chose a path resolves
 * `failed` with the system's message. Kept out of main.ts so it can be tested;
 * the Electron surfaces arrive as arguments, the `file-ipc.ts` shape.
 */

import { promises as fs } from "fs";
import path from "path";
import type { IpcSenderLike } from "./ipc-sender.js";

export const SAVE_FILE_CHANNEL = "file:save";

/**
 * The most one save writes: the engine's ceiling for
 * `maxDesignResponseBodyBytes`, the largest body the renderer can hold to save.
 */
export const SAVE_FILE_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * What `file:save` answers. Mirrored by `saveFile`'s return type in
 * `preload.ts` and `SaveFileReply` in `src/types/electron.d.ts`, neither of
 * which can import from here.
 */
export type SaveFileReply =
	| { outcome: "saved"; path: string }
	| { outcome: "cancelled" }
	| { outcome: "failed"; message: string };

/** The subset of `dialog.showSaveDialog`'s options this channel sets. */
export interface SaveDialogOptions {
	defaultPath: string;
}

interface IpcLike {
	handle(
		channel: string,
		listener: (event: IpcSenderLike, ...args: unknown[]) => unknown
	): unknown;
}

export interface SaveFileIpcDeps {
	/** `dialog.showSaveDialog`, bound to the main window when there is one. */
	showSaveDialog: (
		options: SaveDialogOptions
	) => Promise<{ canceled: boolean; filePath: string }>;
	/** The folder the dialog opens in: `app.getPath("downloads")`, where an `<a download>` went. */
	defaultDirectory: () => string;
	/** `isFromAppMainFrame` against the live main window. */
	isAppFrame: (event: IpcSenderLike) => boolean;
	log: (message: string) => void;
	/** `fs.promises.writeFile` by default; a string is written as UTF-8. */
	writeFile?: (filePath: string, data: string | Uint8Array) => Promise<void>;
}

// eslint-disable-next-line no-control-regex -- the control characters are what it removes
const UNSAFE_NAME_CHARACTERS = /[<>:"|?*\u0000-\u001f\u007f]/g;

/**
 * The name the dialog suggests: the last segment of @p name on either
 * platform's separator, with what Windows refuses in a name (a drive colon
 * among it) and control characters replaced. Throws for a non-string, or one
 * that leaves no name.
 */
export function suggestedFileName(name: unknown): string {
	if (typeof name !== "string") throw new Error("A saved file needs a name.");
	const lastSegment = name.split(/[\\/]/).pop() ?? "";
	const cleaned = lastSegment.replace(UNSAFE_NAME_CHARACTERS, "-").trim();
	if (cleaned === "" || cleaned === "." || cleaned === "..") {
		throw new Error(`Not a file name: ${JSON.stringify(name)}`);
	}
	return cleaned;
}

/** @p contents as what is written: text or bytes, within the cap. Throws for anything else. */
export function saveableContents(contents: unknown): string | Uint8Array {
	if (typeof contents !== "string" && !(contents instanceof Uint8Array)) {
		throw new Error("A saved file's contents must be text or bytes.");
	}
	const size =
		typeof contents === "string" ? Buffer.byteLength(contents, "utf8") : contents.byteLength;
	if (size > SAVE_FILE_MAX_BYTES) {
		throw new Error(
			`The file is ${size} bytes, over the ${SAVE_FILE_MAX_BYTES} a save writes.`
		);
	}
	return contents;
}

/** `file:save`'s whole decision once the sender has passed, exported for the test. */
export async function saveFile(
	contents: unknown,
	name: unknown,
	deps: Omit<SaveFileIpcDeps, "isAppFrame">
): Promise<SaveFileReply> {
	const data = saveableContents(contents);
	const fileName = suggestedFileName(name);
	const chosen = await deps.showSaveDialog({
		defaultPath: path.join(deps.defaultDirectory(), fileName),
	});
	if (chosen.canceled || !chosen.filePath) return { outcome: "cancelled" };
	try {
		await (deps.writeFile ?? fs.writeFile)(chosen.filePath, data);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.log(`Couldn't write a saved file: ${message}`);
		return { outcome: "failed", message };
	}
	return { outcome: "saved", path: chosen.filePath };
}

export function registerSaveFileIpc(ipc: IpcLike, deps: SaveFileIpcDeps): void {
	ipc.handle(SAVE_FILE_CHANNEL, (event, contents: unknown, name: unknown) => {
		if (!deps.isAppFrame(event)) {
			deps.log("Refused a file save asked for from outside the app window");
			throw new Error("Refused: files are saved only from the Vayu window.");
		}
		return saveFile(contents, name, deps);
	});
}
