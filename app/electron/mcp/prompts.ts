/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file prompts.ts
 * @brief MCP prompts - server-provided, parameterized starting points the user
 *        picks from their client (e.g. a slash menu). Each builds a ready-to-run
 *        message, embedding the relevant engine data (run report / comparison)
 *        so the agent has the context inline. See docs/engine/mcp.md.
 */

import { z } from "zod";
import type { ToolContext } from "./tools.js";
import { compareReports } from "./compare.js";

export interface PromptMessage {
	role: "user" | "assistant";
	content: { type: "text"; text: string };
}

export interface PromptResult {
	messages: PromptMessage[];
	description?: string;
}

export interface McpPromptDef {
	name: string;
	title: string;
	description: string;
	argsSchema: z.ZodRawShape;
	build: (
		args: Record<string, unknown>,
		ctx: ToolContext,
		signal?: AbortSignal
	) => Promise<PromptResult>;
}

function userText(text: string): PromptMessage {
	return { role: "user", content: { type: "text", text } };
}

function arg(args: Record<string, unknown>, key: string): string {
	const v = args[key];
	return typeof v === "string" ? v : "";
}

export const PROMPTS: McpPromptDef[] = [
	{
		name: "summarize_run",
		title: "Summarize a run",
		description: "Summarize a completed run's performance from its report.",
		argsSchema: { runId: z.string().describe("Run ID to summarize.") },
		build: async (args, ctx, signal) => {
			const runId = arg(args, "runId");
			const report = await ctx.client.getRunReport(runId, signal);
			return {
				messages: [
					userText(
						"Summarize this Vayu run for an engineer in a few sentences. Call out throughput " +
							"(RPS), latency p50/p95/p99, error rate, and the status-code mix, and say whether " +
							`it looks healthy or concerning.\n\nRun ${runId} report:\n${JSON.stringify(report, null, 2)}`
					),
				],
			};
		},
	},
	{
		name: "compare_runs",
		title: "Compare two runs",
		description: "Compare two runs and assess whether performance regressed.",
		argsSchema: {
			baseRunId: z.string().describe("Baseline run ID (e.g. main)."),
			targetRunId: z.string().describe("Comparison run ID (e.g. the change)."),
		},
		build: async (args, ctx, signal) => {
			const baseRunId = arg(args, "baseRunId");
			const targetRunId = arg(args, "targetRunId");
			const [base, target] = await Promise.all([
				ctx.client.getRunReport(baseRunId, signal),
				ctx.client.getRunReport(targetRunId, signal),
			]);
			const comparison = compareReports(
				baseRunId,
				targetRunId,
				base as Record<string, unknown>,
				target as Record<string, unknown>
			);
			return {
				messages: [
					userText(
						"Did performance regress between these two Vayu runs? Focus on latency percentiles, " +
							"throughput, and error rate; quantify each change and give a clear verdict.\n\n" +
							`Comparison (${baseRunId} -> ${targetRunId}):\n${JSON.stringify(comparison, null, 2)}`
					),
				],
			};
		},
	},
	{
		name: "diagnose_errors",
		title: "Diagnose run errors",
		description: "Investigate the errors and failures in a run.",
		argsSchema: { runId: z.string().describe("Run ID to diagnose.") },
		build: async (args, ctx, signal) => {
			const runId = arg(args, "runId");
			const report = await ctx.client.getRunReport(runId, signal);
			return {
				messages: [
					userText(
						"Diagnose the errors in this Vayu run. Identify which status codes / error types " +
							"dominate, whether failures correlate with load (latency climbing toward saturation), " +
							`and suggest likely causes and the next checks to run.\n\nRun ${runId} report:\n${JSON.stringify(report, null, 2)}`
					),
				],
			};
		},
	},
	{
		name: "suggest_load_profile",
		title: "Suggest a load profile",
		description: "Design a Vayu load test for a target and goal.",
		argsSchema: {
			url: z.string().describe("Target URL to load test."),
			goal: z
				.string()
				.optional()
				.describe("What you want to learn, e.g. 'find the breaking point'."),
		},
		build: async (args) => {
			const url = arg(args, "url");
			const goal = arg(args, "goal") || "understand steady-state capacity";
			return {
				messages: [
					userText(
						`Design a load test with Vayu's start_load_run tool for ${url}. Goal: ${goal}.\n\n` +
							"Recommend a mode (constant_rps, constant_concurrency, ramp_up, or iterations), a " +
							"starting RPS/concurrency, a duration, and how to iterate (e.g. ramp until p99 " +
							"exceeds an SLO). Explain the reasoning, then propose the exact start_load_run " +
							"arguments. Respect Vayu's configured caps and the host allowlist."
					),
				],
			};
		},
	},
];
