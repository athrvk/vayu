/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keeps the Claude Code command Settings > MCP offers to copy equal to the one
 * its Connect button runs (#3576).
 *
 * The renderer writes the snippet (`McpSettingsPanel.tsx`) and the main process
 * writes the argument list it spawns (`connect.ts`). `electron/` cannot import
 * from `app/src` and the panel keeps its snippet table private, so the check
 * reads both source texts. Without `--scope user` the CLI registers Vayu for the
 * current directory only, so a copied command and a clicked button would leave
 * Vayu reachable from different places.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const PANEL_SOURCE = readFileSync(
	new URL("../../src/modules/settings/main/panels/McpSettingsPanel.tsx", import.meta.url),
	"utf8"
);
const CONNECT_SOURCE = readFileSync(new URL("./connect.ts", import.meta.url), "utf8");

const URL_PLACEHOLDER = "<url>";

/** The arguments after `claude` in the panel's Claude Code snippet, URL as a placeholder. */
function snippetArgs(source: string): string[] {
	const match = /`claude ([^`]*?) \$\{url\}`/.exec(source);
	if (!match) return [];
	return [...match[1].split(/\s+/), URL_PLACEHOLDER];
}

/** The argv `connectClient` hands the claude CLI, with the `url` variable as a placeholder. */
function connectArgs(source: string): string[] {
	const match = /\[\s*("mcp",[^\]]*)\]/.exec(source);
	if (!match) return [];
	return match[1].split(",").map((token) => {
		const trimmed = token.trim();
		return trimmed === "url" ? URL_PLACEHOLDER : trimmed.replace(/^"|"$/g, "");
	});
}

describe("copied Claude Code command and Connect button", () => {
	test("both sides were found, so the comparison below compares something", () => {
		expect(snippetArgs(PANEL_SOURCE).length).toBeGreaterThan(1);
		expect(connectArgs(CONNECT_SOURCE).length).toBeGreaterThan(1);
	});

	test("register Vayu with the same arguments, in the same order", () => {
		expect(snippetArgs(PANEL_SOURCE)).toEqual(connectArgs(CONNECT_SOURCE));
	});

	test("both register at user scope", () => {
		expect(snippetArgs(PANEL_SOURCE).join(" ")).toContain("--scope user");
	});
});
