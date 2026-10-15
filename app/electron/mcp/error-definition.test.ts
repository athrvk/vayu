/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file error-definition.test.ts
 * @brief Every surface that hands an agent an error count says what an error is.
 *
 * The engine has one definition (issue #2124): a status outside 2xx/3xx, or no
 * response. An agent that reads `errorRate` without it assumes its own, and a
 * run answering 15% 500s reads as healthy under the transport-only one.
 */

import { describe, expect, test, vi } from "vitest";
import { RUN_ERROR_DEFINITION_SENTENCE } from "./error-definition.js";
import { PROMPTS } from "./prompts.js";
import { RUN_REPORT_RESOURCE } from "./resources.js";
import { resolveSafetyConfig } from "./config.js";
import { TOOLS } from "./tools.js";
import type { ToolContext } from "./tools.js";
import type { EngineClient } from "./engine-client.js";

const REPORT = { latency: { p99: 120 }, summary: { avgRps: 500 }, statusCodes: { "200": 10 } };

function toolDescription(name: string): string {
	const tool = TOOLS.find((t) => t.name === name);
	if (!tool) throw new Error(`tool "${name}" is not registered`);
	return tool.description;
}

describe("the error definition sentence", () => {
	test("states both halves of the definition and the 3xx rule", () => {
		expect(RUN_ERROR_DEFINITION_SENTENCE).toContain("outside 2xx and 3xx");
		expect(RUN_ERROR_DEFINITION_SENTENCE).toContain("no response");
		expect(RUN_ERROR_DEFINITION_SENTENCE).toContain("3xx redirect is a success");
	});

	test("says a request a Stop cancelled is not an error and names where it is counted", () => {
		expect(RUN_ERROR_DEFINITION_SENTENCE).toContain("cancelled by a user Stop is not an error");
		expect(RUN_ERROR_DEFINITION_SENTENCE).toContain("`cancelledRequests`");
	});

	test("names the split on every surface the engine records it", () => {
		for (const key of [
			"httpErrors",
			"noResponse",
			"http_errors",
			"no_response",
			"httpErrorRequests",
			"noResponseRequests",
		]) {
			expect(RUN_ERROR_DEFINITION_SENTENCE).toContain(key);
		}
	});
});

describe("tools and resources that return an error count", () => {
	test.each(["get_live_metrics", "compare_runs", "get_run_report", "get_run_timeseries"])(
		"%s carries the definition",
		(name) => {
			expect(toolDescription(name)).toContain(RUN_ERROR_DEFINITION_SENTENCE);
		}
	);

	test("the run report resource carries the definition", () => {
		expect(RUN_REPORT_RESOURCE.description).toContain(RUN_ERROR_DEFINITION_SENTENCE);
	});
});

describe("prompts that ask about errors", () => {
	const client = {
		getRunReport: vi.fn().mockResolvedValue(REPORT),
	} as unknown as EngineClient;
	// Revealed, so the report is embedded without the masking lookups a fake client lacks.
	const ctx: ToolContext = {
		client,
		config: resolveSafetyConfig({ revealSecretsToAgents: true }),
	};

	test.each([
		["summarize_run", { runId: "run_1" }],
		["compare_runs", { baseRunId: "run_1", targetRunId: "run_2" }],
		["diagnose_errors", { runId: "run_1" }],
	])("%s carries the definition", async (name, args) => {
		const found = PROMPTS.find((p) => p.name === name);
		if (!found) throw new Error(`prompt "${name}" is not registered`);
		const result = await found.build(args, ctx);
		const text = result.messages.map((m) => m.content.text).join("\n");
		expect(text).toContain(RUN_ERROR_DEFINITION_SENTENCE);
	});
});
