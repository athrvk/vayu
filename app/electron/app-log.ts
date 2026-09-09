/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file app-log.ts
 * @brief The two Electron-coupled loggers every main-process module shares
 *        (#1558): `appLogger()` for the app's own lifecycle (`main`,
 *        `sidecar`, `window`, `updater`, `power`, `notify`, `ipc`
 *        categories) and `mcpLogger()` for the Electron-hosted MCP
 *        transport. Both write `app_<stamp>.log` through the same
 *        `LogChannel` (see `log.ts`), so they share one buffer and one
 *        `logLevel` floor.
 *
 * Kept out of `log.ts` itself so that module stays Electron-free -
 * `mcp/cli.ts`, a standalone process with no `app` module, calls
 * `createLogger` directly with its own options.
 *
 * Deliberately reads `engineDataDirectory()` rather than `resolveAppPaths()`:
 * the latter lives in `app-paths.ts`, which itself imports `sidecar.ts`, and
 * `sidecar.ts` is one of this module's own callers - importing
 * `app-paths.ts` here would add a second edge to that cycle for no reason,
 * where `engineDataDirectory` alone already breaks it (a hoisted function
 * declaration, resolved lazily, never called at module-evaluation time).
 */

import path from "path";
import { app } from "electron";
import { createLogger, applyFloorFromEngine, type Logger } from "./log.js";
import { engineDataDirectory } from "./sidecar.js";
import { ENGINE_LOGS_DIR } from "./constants.js";

function consoleEnabled(): boolean {
	return !app.isPackaged || process.env.VAYU_LOG_CONSOLE === "1";
}

function logsDir(): string {
	return path.join(engineDataDirectory(), ENGINE_LOGS_DIR);
}

let sharedAppLogger: Logger | null = null;
/** The app's own logger - `main`, `sidecar`, `window`, `updater`, `power`, `notify`, `ipc`. */
export function appLogger(): Logger {
	sharedAppLogger ??= createLogger("app", {
		logsDir: logsDir(),
		consoleEnabled: consoleEnabled(),
	});
	return sharedAppLogger;
}

let sharedMcpLogger: Logger | null = null;
/** The Electron-hosted MCP transport's logger - same file, `src: "mcp"`. */
export function mcpLogger(): Logger {
	sharedMcpLogger ??= createLogger("mcp", {
		logsDir: logsDir(),
		consoleEnabled: consoleEnabled(),
	});
	return sharedMcpLogger;
}

let sharedRendererLogger: Logger | null = null;
/** What `log-ipc.ts` forwards a renderer's `error-logger.ts` records through - same file, `src: "renderer"`. */
export function rendererLogger(): Logger {
	sharedRendererLogger ??= createLogger("renderer", {
		logsDir: logsDir(),
		consoleEnabled: consoleEnabled(),
	});
	return sharedRendererLogger;
}

export function appLogsPath(): string {
	return logsDir();
}

export { applyFloorFromEngine };
export type { Logger };
