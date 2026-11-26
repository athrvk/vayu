/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The names of the MCP failure classes (`summary.errorClasses`, #3828), for the Overview card and
 * the comparison table alike. Not `httpStatusClass`: a class is not a status, and its tints would
 * read a tool failure as a 4xx.
 */

import type { ErrorClassKey } from "@/lib/run-compare";

export const ERROR_CLASS_LABELS: Record<ErrorClassKey, string> = {
	transport: "Transport",
	protocol: "Protocol",
	tool: "Tool",
};

/** What lands a reply in each class, as the engine decides it (`McpErrorClass`). */
export const ERROR_CLASS_HINTS: Record<ErrorClassKey, string> = {
	transport: "No reply, a failing status with no JSON-RPC error, or a stream that ended early",
	protocol: "A JSON-RPC error in the reply",
	tool: "The tool ran and reported isError",
};
