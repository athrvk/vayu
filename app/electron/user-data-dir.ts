/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the app keeps its data, and the one-time move that put it there.
 *
 * Every release up to 0.36 kept it in `<appData>/vayu-client` - the npm
 * package's name, which Electron derives `userData` from when nothing names a
 * directory. The app now names one, `<appData>/Vayu`, and an install that still
 * has only the old directory is moved on the first launch that finds it.
 *
 * Run from `main.ts` at module scope, before `app.setPath("userData", ...)` and
 * so before anything - Chromium's profile, the single-instance lock, the
 * settings stores, the engine - has opened a file in either directory.
 *
 * Kept free of Electron (the caller passes `appData` in) so it can be driven
 * against real directories in a test. The migration half is scheduled for
 * removal (#1758); `resolveUserDataDirectory` then reduces to the
 * join it returns for a fresh install.
 */

import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { LEGACY_USER_DATA_DIR_NAME, USER_DATA_DIR_NAME } from "./constants.js";

/** What the resolution found, for the one log line `main.ts` writes about it. */
export type UserDataOutcome =
	/** Neither directory existed: a first launch. */
	| "fresh"
	/** The current directory already existed and the legacy one did not. */
	| "current"
	/** The legacy directory was renamed to the current one just now. */
	| "migrated"
	/**
	 * Both existed. The current one is used and the legacy one is left alone:
	 * the current one holding anything at all means a launch already ran from
	 * it, and moving the old one over it would destroy whichever is newer.
	 */
	| "both"
	/**
	 * The rename failed (on Windows, a file still open in the old directory -
	 * an engine left running, say). The legacy directory is used for this
	 * launch so nothing the user has disappears, and the move is retried on the
	 * next one.
	 */
	| "kept-legacy";

export interface UserDataResolution {
	path: string;
	outcome: UserDataOutcome;
	/** Why the move failed, for `kept-legacy` only. */
	error?: string;
}

/** The seams a test replaces; the defaults are the real filesystem. */
export interface UserDataFs {
	exists(target: string): boolean;
	rename(from: string, to: string): void;
}

const realFs: UserDataFs = {
	exists: (target) => existsSync(target),
	rename: (from, to) => renameSync(from, to),
};

export function resolveUserDataDirectory(
	appData: string,
	fs: UserDataFs = realFs
): UserDataResolution {
	const current = path.join(appData, USER_DATA_DIR_NAME);
	const legacy = path.join(appData, LEGACY_USER_DATA_DIR_NAME);

	const hasCurrent = fs.exists(current);
	const hasLegacy = fs.exists(legacy);

	if (hasCurrent) return { path: current, outcome: hasLegacy ? "both" : "current" };
	if (!hasLegacy) return { path: current, outcome: "fresh" };

	try {
		// A rename within one parent directory: atomic, so the data is at one
		// path or the other and never half of each.
		fs.rename(legacy, current);
		return { path: current, outcome: "migrated" };
	} catch (error) {
		// Another launch may have moved it between the check and the rename.
		if (fs.exists(current) && !fs.exists(legacy)) {
			return { path: current, outcome: "current" };
		}
		return { path: legacy, outcome: "kept-legacy", error: String(error) };
	}
}
