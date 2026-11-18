/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's copies of the main process's MCP port rules (#3580), for the
 * Port field's help text, its native bounds and its Reset. `validateMcpPort` in
 * `electron/mcp/store.ts` decides, and renderer and main share no module graph,
 * so these are written twice; `electron/mcp/port-copies.conformance.test.ts`
 * holds them to `MCP_PORT_MIN`, `MCP_PORT_MAX`, `MCP_PORT` and
 * `ENGINE_PORT_CANDIDATES`.
 */

export const MCP_PORT_MIN = 1024;
export const MCP_PORT_MAX = 65535;

/** The port when Settings has not set one, for the Default line and its Reset. */
export const DEFAULT_MCP_PORT = 9877;

/** Every port the engine may take, in the order the sidecar tries them. */
export const ENGINE_PORTS_HELP =
	"Vayu's engine uses 9876, or one of 9880-9889 if that is taken, so none of those can be used here.";
