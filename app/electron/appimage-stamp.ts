/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keeps install.sh's record of the installed Linux version honest.
 *
 * An AppImage carries its version inside a squashfs image, reachable only by mounting or running
 * it, so `install.sh` writes what it installed to a stamp file beside the AppImage and reads that
 * back to decide whether an update is needed. But the AppImage build also updates itself
 * (`resolveUpdateStrategy` returns "silent" on Linux, since electron-updater can verify and replace
 * it in place), so a stamp only the installer writes goes stale: the next `install.sh` run believes
 * an older version is installed and re-downloads 160MB to arrive at the bytes already on disk.
 *
 * The app alone knows its own version for certain, so it writes the stamp itself, at startup rather
 * than on an updater event: startup is right however the version got here (script install, silent
 * update, or someone replacing the file by hand).
 *
 * The paths below deliberately copy install.sh's (LINUX_APP_DIR / LINUX_APP_BIN /
 * LINUX_VERSION_FILE): a shell script and an Electron main process cannot share a constant, so if
 * you move the install location, move it in both.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface StampEnvironment {
	platform: NodeJS.Platform | string;
	/** Set by the AppImage runtime to the path of the .AppImage being run. */
	appImagePath?: string;
	xdgDataHome?: string;
	home?: string;
}

/**
 * The stamp file to write, or null when this process is not the install `install.sh` manages: a
 * .deb install, a development run, and, importantly, an AppImage run from anywhere else. A copy
 * tried out of ~/Downloads must not rewrite the stamp describing the installed copy, or the
 * installer would be told the managed install is a version it is not.
 */
export function resolveStampPath(env: StampEnvironment): string | null {
	if (env.platform !== "linux") return null;
	if (!env.appImagePath) return null;

	// posix, not the host's separator: these are Linux paths by definition (the layout install.sh
	// writes), and on Windows `path.join` answers with backslashes and `path.resolve` prepends a
	// drive letter, so nothing could match and this would silently return null everywhere, as the
	// Windows CI runner reported.
	const join = path.posix.join;
	const dataHome = env.xdgDataHome || (env.home ? join(env.home, ".local", "share") : "");
	if (!dataHome) return null;

	const appDir = join(dataHome, "vayu");
	// Compared as strings, not inodes: a symlinked $HOME would need a realpath on both sides, and
	// this runs on every startup for a purely advisory file. APPIMAGE is set by the AppImage
	// runtime to an absolute path, so there is nothing to normalise away.
	if (env.appImagePath !== join(appDir, "Vayu.AppImage")) return null;

	return join(appDir, "version");
}

/**
 * Write the stamp if it is missing or disagrees; returns whether it wrote. Never throws: a
 * read-only home, a deleted directory or a race with the installer is a reason to skip, never to
 * interfere with startup, and skipping costs one redundant download later.
 */
export async function writeVersionStamp(stampPath: string, version: string): Promise<boolean> {
	try {
		const current = await fs.readFile(stampPath, "utf8").catch(() => null);
		if (current !== null && current.trim() === version) return false;
		await fs.mkdir(path.dirname(stampPath), { recursive: true });
		await fs.writeFile(stampPath, `${version}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** Resolve and write in one call. Safe to fire and forget at startup. */
export async function stampInstalledVersion(
	env: StampEnvironment,
	version: string
): Promise<boolean> {
	const stampPath = resolveStampPath(env);
	if (!stampPath) return false;
	return writeVersionStamp(stampPath, version);
}
