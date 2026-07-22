/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file resources.ts
 * @brief MCP resources - read-only Vayu data an agent can read and attach as
 *        context. Static resources expose the current lists (runs, collections,
 *        environments, engine config); a templated resource
 *        `vayu://run/{runId}/report` exposes any run's full report, with a list
 *        callback (enumerate recent runs) and a completion callback (autocomplete
 *        run IDs). All read-only; no allowlist/caps apply. See docs/engine/mcp.md.
 */

import type { ToolContext } from "./tools.js";

export interface StaticResourceDef {
	name: string;
	uri: string;
	title: string;
	description: string;
	read: (ctx: ToolContext, signal?: AbortSignal) => Promise<unknown>;
}

/** Current-state resources - attach "what's in Vayu right now" as context. */
export const STATIC_RESOURCES: StaticResourceDef[] = [
	{
		name: "runs",
		uri: "vayu://runs",
		title: "Runs",
		description: "All runs (single requests and load tests), newest first.",
		read: (ctx, signal) => ctx.client.listRuns(signal),
	},
	{
		name: "collections",
		uri: "vayu://collections",
		title: "Collections",
		description: "All request collections.",
		read: (ctx, signal) => ctx.client.listCollections(signal),
	},
	{
		name: "environments",
		uri: "vayu://environments",
		title: "Environments",
		description: "All environments (named variable sets).",
		read: (ctx, signal) => ctx.client.listEnvironments(signal),
	},
	{
		name: "engine-config",
		uri: "vayu://config",
		title: "Engine configuration",
		description:
			"The engine's tunable configuration entries with values, defaults, and ranges.",
		read: (ctx, signal) => ctx.client.getConfig(signal),
	},
];

/** Templated per-run report resource. */
export const RUN_REPORT_RESOURCE = {
	name: "run-report",
	uriTemplate: "vayu://run/{runId}/report",
	title: "Run report",
	description:
		"Full report for a run: latency percentiles, throughput, error rate, and status-code mix. Attach as context for analysis.",
	read: (ctx: ToolContext, runId: string, signal?: AbortSignal) =>
		ctx.client.getRunReport(runId, signal),
	listRuns: (ctx: ToolContext, signal?: AbortSignal) => ctx.client.listRuns(signal),
};

/** Best-effort extraction of run IDs from the loosely-typed `/runs` payload. */
export function extractRunIds(runs: unknown): string[] {
	if (!Array.isArray(runs)) return [];
	const ids: string[] = [];
	for (const r of runs) {
		if (r && typeof r === "object") {
			const rec = r as Record<string, unknown>;
			const id = rec.id ?? rec.runId ?? rec._id;
			if (typeof id === "string" && id) ids.push(id);
			else if (typeof id === "number") ids.push(String(id));
		}
	}
	return ids;
}
