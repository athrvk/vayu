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
 * the IPC handler throws a message the caller sees, the menu simply does not
 * offer the item - which is why `isBrowsableUrl` answers the question rather
 * than performing the open.
 *
 * The IPC handler is also the one door a compromised renderer can call in a
 * loop, so `createExternalUrlOpener` adds two limits on top of the scheme rule
 * (#2378): the window must be the one in front, and one open per second. A real
 * click needs the first and cannot beat the second; a script spraying browser
 * tabs at an unattended machine is stopped by both.
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

/** The shortest gap between two opens the IPC handler lets through. */
export const EXTERNAL_OPEN_MIN_INTERVAL_MS = 1000;

export interface ExternalUrlOpenerDeps {
	/** Is the main window the one the user is looking at? False when there is none. */
	isFocused: () => boolean;
	/** Milliseconds from any fixed origin; injected so a test controls the gap. */
	now: () => number;
	/** `shell.openExternal`. Never reached by a refused call. */
	openExternal: (url: string) => Promise<void>;
}

/**
 * The `shell:openExternalUrl` handler body. Every refusal throws, so the
 * renderer's invoke rejects at the call that made it, and none reaches
 * `openExternal`.
 */
export function createExternalUrlOpener(
	deps: ExternalUrlOpenerDeps
): (url: unknown) => Promise<void> {
	let lastOpenAt: number | null = null;

	return async (url) => {
		const scheme = typeof url === "string" ? urlProtocol(url) : null;
		if (typeof url !== "string" || scheme === null) {
			throw new Error("Invalid authorize URL");
		}
		if (!isBrowsableUrl(url)) {
			throw new Error(`Refusing to open non-HTTP(S) URL: ${scheme}`);
		}
		if (!deps.isFocused()) {
			throw new Error("Refusing to open a URL while the window is not focused");
		}
		const now = deps.now();
		if (lastOpenAt !== null && now - lastOpenAt < EXTERNAL_OPEN_MIN_INTERVAL_MS) {
			throw new Error("Refusing to open another URL within a second of the last one");
		}

		// Claimed before the await: two invokes in one tick must not both see an
		// empty slot. A failed open gives the slot back, since nothing opened.
		const previous = lastOpenAt;
		lastOpenAt = now;
		try {
			await deps.openExternal(url);
		} catch (error) {
			lastOpenAt = previous;
			throw error;
		}
	};
}
