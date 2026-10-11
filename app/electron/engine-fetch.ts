/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one way the main process reads or writes the engine's `/config` (#1920).
 *
 * A bare `fetch` has no deadline: an engine that accepts the connection and
 * never answers (mid-startup housekeeping, a wedged DB mutex) parks the caller
 * forever. For `dataFile:read`, `specFile:read`, the proxy bridge and the log
 * floor that is a dialog or a launch step that never completes, and each
 * caller's `catch` fallback is unreachable because nothing ever throws.
 *
 * Takes an absolute URL, not a path: callers hold different bases (the
 * sidecar's live port, `VAYU_ENGINE_URL` for the standalone MCP process, the
 * fixed default). Electron-free, because `log.ts` and `mcp/cli.ts` run without
 * an `app` module.
 */

import { ENGINE_CONFIG_REQUEST_TIMEOUT_MS } from "./constants.js";

/**
 * `fetch` that rejects with a `TimeoutError` once the engine has been silent
 * for `ENGINE_CONFIG_REQUEST_TIMEOUT_MS`. No `signal` in `init`: a caller-owned
 * signal would be silently replaced by the deadline.
 */
export function engineFetch(
	url: string,
	init: Omit<RequestInit, "signal"> = {}
): Promise<Response> {
	return fetch(url, { ...init, signal: AbortSignal.timeout(ENGINE_CONFIG_REQUEST_TIMEOUT_MS) });
}
