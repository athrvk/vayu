/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { MCP_CLIENTS, UNNAMED_MCP_CLIENT, mcpClientDisplayName } from "./mcp-client-names";

/** One expectation per row of the table, spelled out rather than read back from it. */
const EXPECTED: [identifier: string, label: string][] = [
	["claude-code", "Claude Code"],
	["claude-ai", "Claude Desktop"],
	["Visual Studio Code", "VS Code"],
	["Visual-Studio-Code", "VS Code"],
	["Visual Studio Code - Insiders", "VS Code Insiders"],
	["cursor-vscode", "Cursor"],
	["codex-mcp-client", "Codex"],
	["Codex", "Codex"],
	["windsurf-client", "Windsurf"],
	["Windsurf", "Windsurf"],
	["Zed", "Zed"],
	["gemini-cli-mcp-client", "Gemini CLI"],
	["github-copilot-developer", "GitHub Copilot CLI"],
	["Cline", "Cline"],
	["Roo-Code", "Roo Code"],
	["Kilo-Code", "Kilo Code"],
	["continue-cli-client", "Continue"],
	["opencode", "OpenCode"],
	["goose", "Goose"],
	["ChatGPT", "ChatGPT"],
	["JetBrains-IU-copilot-intellij", "JetBrains AI Assistant"],
	["JetBrains-JBC-copilot-intellij", "JetBrains AI Assistant"],
	["com.raycast.macos", "Raycast"],
	["amp-mcp-client", "Amp"],
	["antigravity-client", "Google Antigravity"],
	["Q-DEV-CLI", "Amazon Q Developer CLI"],
	["Postman-Client", "Postman"],
];

describe("mcpClientDisplayName", () => {
	it.each(EXPECTED)("maps %s to %s", (identifier, label) => {
		expect(mcpClientDisplayName(identifier)).toBe(label);
	});

	it.each(EXPECTED)("ignores the case of %s", (identifier, label) => {
		expect(mcpClientDisplayName(identifier.toUpperCase())).toBe(label);
		expect(mcpClientDisplayName(identifier.toLowerCase())).toBe(label);
	});

	it("ignores surrounding whitespace", () => {
		expect(mcpClientDisplayName("  claude-code \n")).toBe("Claude Code");
	});

	it("shows an identifier the registry never saw exactly as sent", () => {
		// Guesses deleted by #1819: nothing was seen sending them.
		for (const guess of [
			"Claude Code",
			"Claude Desktop",
			"vscode",
			"vscode-mcp-client",
			"cursor",
			"gemini-cli",
		]) {
			expect(mcpClientDisplayName(guess)).toBe(guess);
		}
	});

	it("returns an identifier it does not know exactly as sent", () => {
		expect(mcpClientDisplayName("Acme-Agent")).toBe("Acme-Agent");
		// Trimmed, because the engine stores it trimmed; never case-folded.
		expect(mcpClientDisplayName(" Acme-Agent ")).toBe("Acme-Agent");
		// No guessing a product from a substring.
		expect(mcpClientDisplayName("claude-code-fork")).toBe("claude-code-fork");
	});

	it.each([null, undefined, "", "   "])("calls %j the unnamed client", (raw) => {
		expect(mcpClientDisplayName(raw)).toBe("MCP client");
		expect(UNNAMED_MCP_CLIENT).toBe("MCP client");
	});

	it("claims no identifier for two products", () => {
		const all = MCP_CLIENTS.flatMap((c) => c.identifiers.map((i) => i.toLowerCase()));
		expect(all.length).toBeGreaterThan(0);
		expect(new Set(all).size).toBe(all.length);
	});

	it("is covered row for row by the expectations above", () => {
		const expected = new Set(EXPECTED.map(([id]) => id.toLowerCase()));
		const table = MCP_CLIENTS.flatMap((c) => c.identifiers.map((i) => i.toLowerCase()));
		expect([...expected].sort()).toEqual([...table].sort());
	});
});
