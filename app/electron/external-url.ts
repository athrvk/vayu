/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the main process will hand to the OS's browser.
 *
 * Two places decide it and they must decide it the same way: the OAuth flow's
 * `shell:openExternalUrl` handler, where the URL comes from a renderer that a
 * compromised page could be driving, and the context menu's "Open in Browser",
 * where it comes from whatever `href` a document put on screen. Both are
 * arbitrary text arriving from outside, and `shell.openExternal` launches
 * whatever protocol handler the OS has registered for the scheme.
 *
 * So the rule is stated once, here: the two schemes a browser answers for, and
 * nothing else. The two callers differ only in what they do with a refusal -
 * OAuth throws a message the dialog shows, the menu simply does not offer the
 * item - which is why this answers the question rather than performing the open.
 */

/** A URL's protocol, or `null` for text that is not a URL at all. */
export function urlProtocol(value: string): string | null {
	try {
		return new URL(value).protocol;
	} catch {
		return null;
	}
}

/** Whether the OS should be asked to open it. */
export function isBrowsableUrl(value: string): boolean {
	const protocol = urlProtocol(value);
	return protocol === "http:" || protocol === "https:";
}
