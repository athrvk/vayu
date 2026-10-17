/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The run-report formats the MCP server offers (#2139). A copy of the rows of
 * `src/lib/run-export-formats.ts` marked `mcp`, because the packaged server
 * cannot import from `src/` or read engine files at runtime;
 * `run-export-formats.test.ts` holds it to
 * `engine/tests/fixtures/run-export-formats.json`.
 */

/** In the order the engine's `RUN_EXPORT_FORMATS` lists them. */
export const MCP_EXPORT_FORMAT_IDS: readonly string[] = ["json", "markdown"];

/** What an agent reads best: the engine's default is `json`, which suits a program. */
export const defaultMcpExportFormat = "markdown";
