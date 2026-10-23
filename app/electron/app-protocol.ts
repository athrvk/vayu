/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The scheme a packaged build serves its renderer from, `vayu-app://app/`
 * (#2380).
 *
 * A `file:` document has no origin of its own: Chromium matches CSP `'self'`
 * there by scheme, so the policy admitted any local file as a script, a frame
 * or an image. Served from a privileged standard scheme the document has one
 * origin, and `'self'` names it alone.
 *
 * What the scheme may answer is this module's whole job: a file the build
 * shipped under `dist/`, and nothing else - not a path that climbs out of it,
 * not a symlink that points out of it, not another host on the scheme.
 *
 * Kept free of Electron so the mapping is tested against a real directory;
 * main.ts registers the scheme and hands `net.fetch` in.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { APP_HOST, APP_SCHEME } from "./constants.js";
import { isWithin } from "./path-within.js";

/**
 * What the scheme is registered with, before the app is ready. `standard`
 * gives it a host and relative-URL resolution (the build's `base: "./"` asset
 * paths); `secure` makes the document a secure context; `supportFetchAPI` lets
 * the renderer fetch from it, which Monaco's module workers need.
 *
 * Absent on purpose: `bypassCSP` (the policy applying is the point),
 * `corsEnabled` (the engine is reached through `engine-origin.ts`, not through
 * a CORS grant on this scheme) and `allowServiceWorkers` (the app registers
 * none).
 */
export const APP_SCHEME_PRIVILEGES = {
	standard: true,
	secure: true,
	supportFetchAPI: true,
} as const;

/** The dist-relative path an app-scheme URL names, or null for any other URL. */
function requestedPath(requestUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(requestUrl);
	} catch {
		return null;
	}
	if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;

	let decoded: string;
	try {
		decoded = decodeURIComponent(url.pathname);
	} catch {
		return null;
	}
	// The pathname always begins with "/". What follows is relative to the root,
	// so a second leading slash (`//etc/passwd`) stays absolute and is refused by
	// the containment check rather than quietly re-rooted.
	const relative = decoded.slice(1);
	return relative === "" ? "index.html" : relative;
}

/**
 * The file under @p distRoot that @p requestUrl names, or null when it names
 * nothing the build shipped: another scheme or host, a path outside the root,
 * or no regular file there. `/` is the entry document.
 *
 * Containment is decided on canonical paths, both ends through `realpath`, so
 * one check refuses `..` (however it was encoded), an absolute path and a
 * symlink that resolves out of the root alike. A lexical check alone would
 * pass the symlink.
 */
export async function resolveAppFile(requestUrl: string, distRoot: string): Promise<string | null> {
	const relative = requestedPath(requestUrl);
	if (relative === null) return null;
	try {
		const root = await fs.realpath(distRoot);
		const file = await fs.realpath(path.resolve(root, relative));
		if (!isWithin(root, file)) return null;
		return (await fs.stat(file)).isFile() ? file : null;
	} catch {
		// Missing, unreadable, or a name the filesystem refuses (a NUL byte).
		return null;
	}
}

/**
 * The `protocol.handle` handler: the named file through @p fetchFile (main
 * passes `net.fetch`, so Chromium supplies the MIME type), or a 404.
 */
export function createAppProtocolHandler(
	distRoot: string,
	fetchFile: (fileUrl: string) => Promise<Response>
): (request: { url: string }) => Promise<Response> {
	return async (request) => {
		const file = await resolveAppFile(request.url, distRoot);
		if (file === null) return new Response(null, { status: 404 });
		return fetchFile(pathToFileURL(file).toString());
	};
}
