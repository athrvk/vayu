/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file app-paths.ts
 * @brief The directories Settings - General shows the user.
 *
 * Extracted from the `app:getPaths` handler, which had grown its own copy of
 * the sidecar's data-dir rule and of the engine's `logs`/`db` layout. Two
 * copies of a derivation drift silently here: the panel keeps rendering, it
 * just names directories nothing writes to. The derivation now has one owner
 * per layer - `engineDataDirectory()` for the data dir, `constants.ts` for the
 * subdirectory names - and this module only joins them.
 */

import { app } from "electron";
import path from "path";
import { ENGINE_DB_DIR, ENGINE_LOGS_DIR } from "./constants.js";
import { engineDataDirectory } from "./sidecar.js";

/** Wire shape of `app:getPaths`; mirrored in `src/types/electron.d.ts`. */
export interface AppPaths {
	appDir: string;
	dataDir: string;
	logsPath: string;
	dbPath: string;
}

export function resolveAppPaths(): AppPaths {
	const dataDir = engineDataDirectory();
	return {
		appDir: app.getAppPath(),
		dataDir,
		logsPath: path.join(dataDir, ENGINE_LOGS_DIR),
		dbPath: path.join(dataDir, ENGINE_DB_DIR),
	};
}
