/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How the auto-updater should behave on the current platform.
 *
 * - "silent":   download in the background, prompt to restart-and-install
 *               (electron-updater can cryptographically verify the artifact)
 * - "notify":   only check for a newer version and surface it in the UI; the
 *               user updates out-of-band (macOS re-runs install.sh, deb users
 *               use their package manager)
 * - "disabled": no update checks at all (development)
 */
export type UpdateStrategy = "silent" | "notify" | "disabled";

export interface UpdateStrategyInput {
	platform: NodeJS.Platform | string;
	isDev: boolean;
	isAppImage: boolean;
}

export function resolveUpdateStrategy({
	platform,
	isDev,
	isAppImage,
}: UpdateStrategyInput): UpdateStrategy {
	if (isDev) {
		return "disabled";
	}

	switch (platform) {
		// macOS ships ad-hoc signed (no Apple Developer ID), so Squirrel.Mac
		// cannot verify a downloaded update - notify only.
		case "darwin":
			return "notify";
		case "win32":
			return "silent";
		// Only the AppImage build supports in-place auto-update; .deb installs
		// are managed by the system package manager.
		case "linux":
			return isAppImage ? "silent" : "notify";
		default:
			return "notify";
	}
}
