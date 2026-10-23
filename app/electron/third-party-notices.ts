/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file third-party-notices.ts
 * @brief Open the installer's THIRD_PARTY_NOTICES.txt (#2693).
 *
 * The file is generated at package time into `app/build/` and shipped loose by
 * `extraResources` (outside the asar, so the OS can open it). It exists only in
 * a packaged build, so a development run answers with a sentence instead of a
 * path into the repo, unless a build has already staged a copy.
 *
 * Electron-free: everything it needs is passed in, so both branches are unit
 * tests. Returns what `shell.openPath` returns - an empty string on success,
 * the reason on failure - because that is the shape `app:openLogsFolder` already
 * gives the renderer.
 */

import path from "path";

export const THIRD_PARTY_NOTICES_FILE = "THIRD_PARTY_NOTICES.txt";

export const NOTICES_NOT_GENERATED =
	"The notices aren't generated in a development build. Run build.py to produce them.";

export const NOTICES_MISSING = "The notices file is missing from this installation.";

export interface NoticesLocation {
	isDev: boolean;
	/** `app.getAppPath()`: the `app/` directory in development. */
	appPath: string;
	/** `process.resourcesPath`: where `extraResources` land in a packaged build. */
	resourcesPath: string;
	exists: (filePath: string) => boolean;
}

export interface ShellLike {
	openPath(targetPath: string): Promise<string>;
}

/** The file to open, or the sentence that says why there is none. */
export function locateThirdPartyNotices(
	location: NoticesLocation
): { path: string } | { error: string } {
	if (location.isDev) {
		const staged = path.join(location.appPath, "build", THIRD_PARTY_NOTICES_FILE);
		return location.exists(staged) ? { path: staged } : { error: NOTICES_NOT_GENERATED };
	}
	const installed = path.join(location.resourcesPath, THIRD_PARTY_NOTICES_FILE);
	return location.exists(installed) ? { path: installed } : { error: NOTICES_MISSING };
}

export async function openThirdPartyNotices(
	location: NoticesLocation,
	shellApi: ShellLike
): Promise<string> {
	const found = locateThirdPartyNotices(location);
	if ("error" in found) return found.error;
	return await shellApi.openPath(found.path);
}

/**
 * The Help menu item. A menu click has no panel to show a reason in, so the
 * failure goes to the log, where a bug report can find it.
 */
export async function openThirdPartyNoticesFromMenu(
	open: () => Promise<string>,
	log: (msg: string, fields: { failure: string }) => void
): Promise<void> {
	const failure = await open();
	if (failure) log("Couldn't open the third-party notices", { failure });
}
