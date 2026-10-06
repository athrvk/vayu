/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Product names for the MCP client identifiers a run records (issue #1817).
 *
 * A run an agent started carries the `clientInfo.name` that client sent in its
 * `initialize` handshake, as sent. That string is whatever the client's author
 * chose, so it is shown through this table: `claude-ai` is not a name anyone
 * would call Claude Desktop.
 *
 * **Unmeasured.** These spellings come from the clients' public documentation
 * and source, not from a capture of each client talking to Vayu, and a client
 * may change its identifier in any release. A row that is wrong or missing
 * degrades to the raw identifier (below), never to a wrong product name, so the
 * cost of a stale row is an ugly label. When a client's real identifier has
 * been observed (the run's row in History shows the raw string for an unknown
 * one), adding it is one line in `MCP_CLIENTS`.
 *
 * Matching is case-insensitive on the trimmed identifier. An identifier this
 * table does not know is returned as sent: guessing a product from a
 * substring would be the one answer worse than the raw name.
 */
export const MCP_CLIENTS: readonly { label: string; identifiers: readonly string[] }[] = [
	{ label: "Claude Code", identifiers: ["claude-code", "Claude Code"] },
	{ label: "Claude Desktop", identifiers: ["claude-ai", "Claude Desktop"] },
	{ label: "VS Code", identifiers: ["Visual Studio Code", "vscode", "vscode-mcp-client"] },
	{ label: "Cursor", identifiers: ["cursor-vscode", "cursor"] },
	{ label: "Codex", identifiers: ["codex-mcp-client", "codex"] },
	{ label: "Windsurf", identifiers: ["windsurf-client", "windsurf"] },
	{ label: "Zed", identifiers: ["zed"] },
	{ label: "Gemini CLI", identifiers: ["gemini-cli-mcp-client", "gemini-cli"] },
];

/** What a run started by an agent that sent no name is called. */
export const UNNAMED_MCP_CLIENT = "MCP client";

const LABEL_BY_IDENTIFIER = new Map<string, string>(
	MCP_CLIENTS.flatMap(({ label, identifiers }) =>
		identifiers.map((identifier) => [identifier.toLowerCase(), label] as const)
	)
);

/**
 * The label a run's MCP client is shown under: its product name when the
 * identifier is in {@link MCP_CLIENTS}, the identifier itself when it is not,
 * and {@link UNNAMED_MCP_CLIENT} when there is none.
 */
export function mcpClientDisplayName(raw: string | null | undefined): string {
	const identifier = raw?.trim();
	if (!identifier) return UNNAMED_MCP_CLIENT;
	return LABEL_BY_IDENTIFIER.get(identifier.toLowerCase()) ?? identifier;
}
