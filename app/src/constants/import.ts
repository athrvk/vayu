/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What each stage of an import is called on screen (#882). One map, not a `switch` at the render
 * site, because these words appear in two places (the panel that replaces the dropzone while a
 * batch runs, and the footer bar while the apply runs), and a stage named two ways is a stage a
 * user cannot follow between them. Named for what is happening to the user's documents, not for the
 * code path: "Resolving references" is a `$ref` walk, and "bundling" would name an implementation
 * nobody outside this repo has heard of.
 */
export const IMPORT_STAGE_LABELS = {
	reading: "Reading files",
	connecting: "Asking the server",
	fetching: "Downloading",
	bundling: "Resolving references",
	parsing: "Reading documents",
	applying: "Importing",
} as const;

/**
 * The events a streamed `POST /import/fetch` sends, mirroring `constants::import_fetch::EVENT_*`
 * engine-side (#882). Named here, not compared as bare strings, for the reason every wire contract
 * in this directory is: an unknown SSE event is one the reader skips, so a drifted name would not
 * throw; the download would report into a branch nothing takes, and the bar would sit at zero while
 * the bytes arrived.
 */
export const IMPORT_FETCH_EVENTS = {
	PROGRESS: "progress",
	RESULT: "result",
	ERROR: "error",
} as const;

/**
 * How long the engine lets `POST /import/fetch` sit below a trickle before it abandons the
 * download, mirroring `constants::import_fetch::STALL_TIMEOUT_MS` (`import.engine-parity.test.ts`
 * pins the two). The route is bounded by this stall, never by the `defaultTimeout` setting, so the
 * renderer's budget for the call derives from it: a budget derived from the setting would abort a
 * download the engine is still reading, or a connect the engine is still allowed to wait on.
 */
export const IMPORT_FETCH_STALL_TIMEOUT_MS = 30_000;

/**
 * The whole-import bound `POST /import/mcp` holds a server to, mirroring
 * `constants::import_mcp::TOTAL_TIMEOUT_MS` (`import.engine-parity.test.ts` pins the two). The
 * renderer's budget for the call derives from it, so the engine's own 502 names the overrun
 * before the client gives up.
 */
export const IMPORT_MCP_TOTAL_TIMEOUT_MS = 120_000;

/**
 * What an MCP import's tree is named, mirroring `MCP_IMPORT_FORMAT` and `MCP_TOKEN_VARIABLE`
 * (`mcp_import.hpp`; `import.engine-parity.test.ts` pins both). The format says the tree came from
 * a server, and the variable is the secret one a bearer import leaves empty for the user to fill.
 */
export const IMPORT_MCP_FORMAT = "MCP server";
export const IMPORT_MCP_TOKEN_VARIABLE = "mcpToken";
