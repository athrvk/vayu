/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The log files are not an MCP surface (#3635). The Logs tab reads them for a
 * person at the keyboard, over IPC that answers only the app window; an agent
 * that could page the same files would read what the app logged about the
 * user's requests, and past the masking every MCP read goes through.
 *
 * Two holds, because a tool can reach the files without being named for them:
 * no tool, resource or prompt carries "log" or "logs" in its name, title or
 * URI, and nothing under `electron/mcp/` imports the reader.
 *
 * Mutation check: name a tool `read_logs`, a resource `vayu://logs` or a prompt
 * `tail_log`, or import `../log-reader.js` from a source here, and the
 * matching case reds.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROMPTS } from "./prompts.js";
import { RUN_REPORT_RESOURCE, STATIC_RESOURCES } from "./resources.js";
import { TOOLS } from "./tools.js";

/** `log`, `logs` or `logging` as a word of a snake_case, kebab-case or URI name; not `login`. */
const NAMES_A_LOG = /(?:^|[^a-z])logs?(?:ging)?(?:[^a-z]|$)/i;

const READER_IMPORT = /from\s+["'][^"']*\blog-reader(?:-ipc)?(?:\.js)?["']/;

const here = path.dirname(fileURLToPath(import.meta.url));

/** The first-party sources of the MCP server, tests and testkits aside. */
function mcpSources(): string[] {
	return readdirSync(here, { recursive: true, encoding: "utf8" }).filter(
		(file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("testkit")
	);
}

describe("what names a log", () => {
	it.each([
		["read_logs", true],
		["tail_log", true],
		["get-app-logs", true],
		["vayu://logs", true],
		["vayu://logs/app", true],
		["Logging", true],
		["login", false],
		["catalogue", false],
		["list_runs", false],
		["vayu://run/{runId}/report", false],
	])("%s: %s", (name, expected) => {
		expect(NAMES_A_LOG.test(name)).toBe(expected);
	});

	it.each([
		['import { readLogs } from "../log-reader.js";', true],
		["import type { LogBatch } from '../log-reader';", true],
		['import { registerLogReaderIpc } from "../log-reader-ipc.js";', true],
		['import { createLogger } from "../log.js";', false],
	])("%s: %s", (source, expected) => {
		expect(READER_IMPORT.test(source)).toBe(expected);
	});
});

describe("the MCP registries", () => {
	it("hold tools, resources and prompts to read", () => {
		expect(TOOLS.length).toBeGreaterThan(20);
		expect(STATIC_RESOURCES.length).toBeGreaterThan(0);
		expect(PROMPTS.length).toBeGreaterThan(0);
	});

	it("name no tool for a log", () => {
		const names = TOOLS.flatMap((tool) => [tool.name, tool.annotations.title ?? ""]);
		expect(names.filter((name) => NAMES_A_LOG.test(name))).toEqual([]);
	});

	it("name no resource for a log", () => {
		const resources = [...STATIC_RESOURCES, RUN_REPORT_RESOURCE];
		const names = resources.flatMap((resource) => [
			resource.name,
			resource.title,
			"uri" in resource ? resource.uri : resource.uriTemplate,
		]);
		expect(names.filter((name) => NAMES_A_LOG.test(name))).toEqual([]);
	});

	it("name no prompt for a log", () => {
		const names = PROMPTS.flatMap((prompt) => [prompt.name, prompt.title]);
		expect(names.filter((name) => NAMES_A_LOG.test(name))).toEqual([]);
	});
});

describe("the MCP sources", () => {
	it("import neither the log reader nor its IPC", () => {
		const sources = mcpSources();
		// A scan that found nothing read nothing.
		expect(sources.length).toBeGreaterThan(20);
		const importers = sources.filter((file) =>
			READER_IMPORT.test(readFileSync(path.join(here, file), "utf8"))
		);
		expect(importers).toEqual([]);
	});
});
