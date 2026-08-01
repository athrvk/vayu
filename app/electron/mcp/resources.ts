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
 *        run IDs). `vayu://scripting/completions` re-serves the engine's own
 *        script-sandbox surface so an agent discovers it the way the editor does,
 *        instead of from a prose copy that drifts (issue #233).
 *        All read-only; no allowlist/caps apply. See docs/engine/mcp.md.
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
	{
		name: "scripting",
		uri: "vayu://scripting/completions",
		title: "Script sandbox API",
		description:
			"Every name the pre-request / test script sandbox provides: pm.request and pm.response, " +
			"the pm.expect assertion chains, the variable scopes, pm.crypto (synchronous SHA-256 / " +
			"HMAC-SHA256) and the btoa / atob globals. Read this before writing a preRequestScript " +
			"or postRequestScript.",
		read: async (ctx, signal) =>
			projectScriptingSurface(await ctx.client.getScriptCompletions(signal)),
	},
];

/** One sandbox name as an agent sees it - the engine's own keys, minus Monaco's. */
export interface ScriptingApiEntry {
	label: string;
	detail?: string;
	documentation?: string;
}

export interface ScriptingSurface {
	version?: unknown;
	engine?: unknown;
	completions: ScriptingApiEntry[];
}

/**
 * Reduce `GET /scripting/completions` to the three fields that mean something
 * outside an editor. `insertText`, `insertTextRules`, `sortText`, `filterText`
 * and `kind` are Monaco's - snippet placeholders (`${1:secret}`) and a
 * `CompletionItemKind` enum an agent has no use for.
 *
 * Every entry survives, snippets included: dropping them would mean testing
 * `kind === 28`, which is exactly the copied-constant drift this resource exists
 * to avoid, and a snippet's label plus documentation still names a capability.
 *
 * Throws rather than returning a partial surface - an agent that reads a
 * silently-truncated API list concludes the sandbox cannot do what it can.
 */
export function projectScriptingSurface(payload: unknown): ScriptingSurface {
	const root =
		payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
	if (!root || !Array.isArray(root.completions)) {
		throw new Error(
			"GET /scripting/completions returned no `completions` array - cannot describe the script sandbox"
		);
	}
	const completions: ScriptingApiEntry[] = [];
	for (const item of root.completions) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		if (typeof rec.label !== "string" || !rec.label) continue;
		completions.push({
			label: rec.label,
			...(typeof rec.detail === "string" ? { detail: rec.detail } : {}),
			...(typeof rec.documentation === "string" ? { documentation: rec.documentation } : {}),
		});
	}
	return { version: root.version, engine: root.engine, completions };
}

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

/**
 * Best-effort extraction of run IDs from the loosely-typed `/runs` payload.
 * Accepts both the paginated `{data: [...]}` envelope (current) and a bare
 * array (the legacy no-param shape), so it survives either.
 */
export function extractRunIds(runs: unknown): string[] {
	const rows =
		Array.isArray(runs)
			? runs
			: runs && typeof runs === "object" && Array.isArray((runs as { data?: unknown }).data)
				? (runs as { data: unknown[] }).data
				: null;
	if (!rows) return [];
	const ids: string[] = [];
	for (const r of rows) {
		if (r && typeof r === "object") {
			const rec = r as Record<string, unknown>;
			const id = rec.id ?? rec.runId ?? rec._id;
			if (typeof id === "string" && id) ids.push(id);
			else if (typeof id === "number") ids.push(String(id));
		}
	}
	return ids;
}
