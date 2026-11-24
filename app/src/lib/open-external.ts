/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Open in the system browser, never in this window. The main process refuses a
 * window that is not focused and a second open within a second (#2378); a click
 * has nothing more to say about that, so the rejection ends here rather than
 * surfacing as an unhandled one.
 *
 * A link from a document the user did not write (markdown, an MCP reply) is a
 * button that calls this, never an `<a href>`: a navigating anchor would load
 * the page in the renderer, which hands `window.electronAPI` to it.
 */
export async function openExternal(url: string): Promise<void> {
	try {
		await window.electronAPI?.openExternalUrl?.(url);
	} catch {
		// Refused by the main process; the link simply does not open.
	}
}

/** The URL when it is http(s), the only schemes `openExternalUrl` opens; else null. */
export function httpUrlOf(text: string): string | null {
	try {
		const { protocol } = new URL(text);
		return protocol === "http:" || protocol === "https:" ? text : null;
	} catch {
		return null;
	}
}
