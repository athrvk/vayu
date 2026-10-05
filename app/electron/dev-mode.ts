/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { app } from "electron";

/**
 * Whether this is a development run: unpackaged, with `NODE_ENV=development`.
 *
 * `app.isPackaged` is part of the test because an environment variable is not
 * the user's to set on a shipped build - one that was launched with
 * `NODE_ENV=development` would load `http://localhost:5173` with the preload
 * attached and switch the updater off (#1780). Decided here once; the main
 * process, the sidecar and the updater all ask the same question.
 */
export function isDevelopmentBuild(): boolean {
	return !app.isPackaged && process.env.NODE_ENV === "development";
}
