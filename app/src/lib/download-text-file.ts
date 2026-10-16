/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The app's one file-to-disk path (#2127): a Blob behind an object URL and a
 * click on an `<a download>`. No IPC and no save dialog - there is no such
 * bridge, and an export does not need one.
 */

/**
 * Hand `text` to the browser as a file called `fileName`.
 *
 * @param mimeType - the Blob's type, e.g. `application/json`.
 */
export function downloadTextFile(text: string, fileName: string, mimeType: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.click();
	URL.revokeObjectURL(url);
}
