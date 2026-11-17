/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The app's one file-to-disk path (#2127), which answers what became of the
 * file (#3246). In Electron it is `electronAPI.saveFile`: main opens the system
 * save dialog and writes the bytes, so a caller learns whether the user saved,
 * cancelled or hit a write error, and says "Exported" only for the first.
 * Without the bridge (the renderer under plain vite) it is a click on an
 * `<a download>`, which cannot report back and resolves `saved`.
 */

/**
 * What a save came to: written, declined at the dialog, or failed with a
 * sentence to show. `fileName` is the file the user chose in the dialog, which
 * may differ from the name suggested (#3607); a `failed` has none when it came
 * before a path was chosen (main refused the call, the bytes could not be read).
 * The `<a download>` fallback never learns the chosen name and answers the
 * suggested one.
 */
export type FileSaveOutcome =
	| { outcome: "saved"; fileName: string }
	| { outcome: "cancelled" }
	| { outcome: "failed"; message: string; fileName?: string };

type SaveFileBridge = NonNullable<Window["electronAPI"]>["saveFile"];

function bridge(): SaveFileBridge | undefined {
	return typeof window === "undefined" ? undefined : window.electronAPI?.saveFile;
}

/** A rejection (main refused the call, the bytes could not be read) is a failure like any other. */
async function saveThroughBridge(
	save: SaveFileBridge,
	contents: Promise<string | Uint8Array> | string,
	fileName: string
): Promise<FileSaveOutcome> {
	try {
		return await save(await contents, fileName);
	} catch (error) {
		return {
			outcome: "failed",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

function clickDownloadAnchor(blob: Blob, fileName: string): FileSaveOutcome {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.click();
	URL.revokeObjectURL(url);
	return { outcome: "saved", fileName };
}

/** Save `blob` as a file called `fileName`, its bytes untouched. */
export async function downloadBlob(blob: Blob, fileName: string): Promise<FileSaveOutcome> {
	const save = bridge();
	if (!save) return clickDownloadAnchor(blob, fileName);
	return saveThroughBridge(
		save,
		blob.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
		fileName
	);
}

/**
 * Save `text` as a file called `fileName`, encoded as UTF-8.
 *
 * @param mimeType - the fallback Blob's type, e.g. `application/json`.
 */
export async function downloadTextFile(
	text: string,
	fileName: string,
	mimeType: string
): Promise<FileSaveOutcome> {
	const save = bridge();
	if (!save) return clickDownloadAnchor(new Blob([text], { type: mimeType }), fileName);
	return saveThroughBridge(save, text, fileName);
}

/**
 * What a toast says for a save that `failed`: the file and the system's reason.
 * The file is the one the user chose when main got that far, else the name the
 * caller suggested.
 */
export function saveFailedMessage(
	suggestedName: string,
	failure: Extract<FileSaveOutcome, { outcome: "failed" }>
): string {
	return `Couldn't save ${failure.fileName ?? suggestedName} - ${failure.message}`;
}
