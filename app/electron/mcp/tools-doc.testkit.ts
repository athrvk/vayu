/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file tools-doc.testkit.ts
 * @brief Renders `docs/engine/mcp/tools.md` from the tool registry, so the tool
 *        table and the count the docs state are derived rather than kept by hand.
 *
 * `tools-doc.fresh.test.ts` holds the committed page equal to this output and
 * rewrites it under `pnpm docs:mcp-tools`; `tool-count-docs.test.ts` holds every
 * other page free of a count and the page's one count line equal to
 * {@link countLine}. The page is machine output: edit this file, not the page.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { PROMPTS } from "./prompts.js";
import { STATIC_RESOURCES } from "./resources.js";
import { TOOLS } from "./tools.js";
import type { McpTool } from "./tools/contract.js";

/** Repository-relative path of the page this module renders. */
export const TOOLS_DOC_PATH = "docs/engine/mcp/tools.md";

/** The templated `vayu://run/{runId}/report` is listed beside the static ones. */
export const TEMPLATED_RESOURCES = 1;

/** The one place a published page states how many tools, resources and prompts exist. */
export function countLine(): string {
	const resources = STATIC_RESOURCES.length + TEMPLATED_RESOURCES;
	return `**${TOOLS.length} tools, ${resources} resources, ${PROMPTS.length} prompts.**`;
}

/** The annotation hints a tool declares as true, in a fixed order. */
const HINTS: ReadonlyArray<readonly [keyof ToolAnnotations, string]> = [
	["readOnlyHint", "read-only"],
	["destructiveHint", "destructive"],
	["idempotentHint", "idempotent"],
	["openWorldHint", "open-world"],
];

function hintsOf(annotations: ToolAnnotations): string {
	const set = HINTS.filter(([key]) => annotations[key] === true).map(([, label]) => label);
	return set.length > 0 ? set.join(", ") : "-";
}

/**
 * A table cell. The backslash is escaped first, so a title that ends in one, or
 * holds `\|`, cannot swallow the pipe that follows it; the pipe would split the
 * cell and a newline would end the row.
 */
export function tableCell(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function row(tool: McpTool): string {
	const title = tool.annotations.title ?? "-";
	return `| \`${tool.name}\` | ${tool.category} | ${tableCell(title)} | ${hintsOf(tool.annotations)} |`;
}

/** The whole page, as committed. Tools are sorted by name, one row each. */
export function renderToolsDoc(tools: readonly McpTool[] = TOOLS): string {
	const rows = [...tools].sort((a, b) => (a.name < b.name ? -1 : 1)).map(row);
	return [
		"---",
		"description: >-",
		"  Every tool the Vayu MCP server registers, with its category and annotation hints, generated from the tool registry.",
		"---",
		"",
		"# MCP tools",
		"",
		"<!-- Generated from the TOOLS registry (app/electron/mcp/tools/*.tools.ts) by",
		"app/electron/mcp/tools-doc.testkit.ts. Do not edit: run `pnpm docs:mcp-tools` from app/. -->",
		"",
		countLine(),
		"",
		"One row per tool, sorted by name.",
		"The category decides which gate applies ([Tool conventions](conventions.md)).",
		"The hints are the MCP annotations the server declares for the tool.",
		"What a tool does and takes is its own description, which a client reads from `tools/list`;",
		"the notes on each family of tools are linked from [the overview](index.md).",
		"",
		"| Tool | Category | Title | Hints |",
		"| ---- | -------- | ----- | ----- |",
		...rows,
		"",
	].join("\n");
}
