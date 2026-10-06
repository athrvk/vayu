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
 * **Evidence per row** (checked 2026-10-06; every row is an identifier some
 * client was seen to send, none is a capture of a client talking to Vayu, and
 * a client may rename itself in any release):
 * - From the client's own source: `gemini-cli-mcp-client` (gemini-cli
 *   `packages/core/src/tools/mcp-client.ts`), `Zed` (zed `context_server`),
 *   `Visual Studio Code` and `Visual Studio Code - Insiders` (vscode
 *   `mcpServerRequestHandler.ts` sends `productService.nameLong`, and the
 *   Microsoft builds substitute their product name; a fork sends its own and
 *   falls through to the raw identifier).
 * - Observed in `initialize` requests real clients sent to Apify's MCP server,
 *   as recorded by the community registry apify/mcp-client-capabilities
 *   (`mcp-clients.json`, 43 entries, snapshot 2026-10-06; browsable at
 *   canimcp.dev): every other row. `claude-ai` is shared by Claude Desktop and
 *   Claude.ai, and the registry lists two spellings each for VS Code
 *   (`Visual-Studio-Code`), Codex and Windsurf.
 * - Deleted for having no evidence anywhere: `Claude Code`, `Claude Desktop`,
 *   `vscode`, `vscode-mcp-client`, `cursor`, `gemini-cli`.
 *
 * A row that is wrong or missing degrades to the raw identifier (below),
 * never to a wrong product name. #1819 stays open for what this does not
 * settle: a capture from each client against Vayu, with its version, and
 * whether it echoes `Mcp-Session-Id` over HTTP.
 *
 * Matching is case-insensitive on the trimmed identifier. An identifier this
 * table does not know is returned as sent: guessing a product from a
 * substring would be the one answer worse than the raw name.
 */
export const MCP_CLIENTS: readonly { label: string; identifiers: readonly string[] }[] = [
	{ label: "Claude Code", identifiers: ["claude-code"] },
	{ label: "Claude Desktop", identifiers: ["claude-ai"] },
	{ label: "VS Code", identifiers: ["Visual Studio Code", "Visual-Studio-Code"] },
	{ label: "VS Code Insiders", identifiers: ["Visual Studio Code - Insiders"] },
	{ label: "Cursor", identifiers: ["cursor-vscode"] },
	{ label: "Codex", identifiers: ["codex-mcp-client", "Codex"] },
	{ label: "Windsurf", identifiers: ["windsurf-client", "Windsurf"] },
	{ label: "Zed", identifiers: ["Zed"] },
	{ label: "Gemini CLI", identifiers: ["gemini-cli-mcp-client"] },
	{ label: "GitHub Copilot CLI", identifiers: ["github-copilot-developer"] },
	{ label: "Cline", identifiers: ["Cline"] },
	{ label: "Roo Code", identifiers: ["Roo-Code"] },
	{ label: "Kilo Code", identifiers: ["Kilo-Code"] },
	{ label: "Continue", identifiers: ["continue-cli-client"] },
	{ label: "OpenCode", identifiers: ["opencode"] },
	{ label: "Goose", identifiers: ["goose"] },
	{ label: "ChatGPT", identifiers: ["ChatGPT"] },
	{
		label: "JetBrains AI Assistant",
		identifiers: ["JetBrains-IU-copilot-intellij", "JetBrains-JBC-copilot-intellij"],
	},
	{ label: "Raycast", identifiers: ["com.raycast.macos"] },
	{ label: "Amp", identifiers: ["amp-mcp-client"] },
	{ label: "Google Antigravity", identifiers: ["antigravity-client"] },
	{ label: "Amazon Q Developer CLI", identifiers: ["Q-DEV-CLI"] },
	{ label: "Postman", identifiers: ["Postman-Client"] },
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
